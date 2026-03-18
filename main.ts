import { Application, send } from "@oak/oak";
import { Router, RouterContext } from "@oak/oak/router";
import webpush from "web-push";

const port = Number(Deno.env.get("PORT") ?? "5353");
const gymName = Deno.env.get("DEFAULT_CLYMBE_GYM_NAME") ?? "Vital Lower East Side";

type Note = { from: string; text: string };

type PersonHere = {
  name: string;
  checked_in_at: string;
  checkout_at?: string;
  notes?: Note[];
  reactions?: Record<string, string[]>;
};

type Status = {
  gym_name: string;
  people_here: PersonHere[];
  last_check_in: string | null;
  check_in_count: number;
  updated_at: string;
};

const createStatus = (): Status => ({
  gym_name: gymName,
  people_here: [],
  last_check_in: null,
  check_in_count: 0,
  updated_at: new Date().toISOString()
});

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, " ");

const namesEqual = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const formatCheckoutLabel = (checkoutAt: string): string => {
  const time = new Date(checkoutAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Here until ${time}`;
};

const buildPresenceNote = (customNote: string | undefined, checkoutAt?: string): string | undefined => {
  const trimmedCustom = customNote?.trim();
  if (!checkoutAt) {
    return trimmedCustom || undefined;
  }

  const untilLabel = formatCheckoutLabel(checkoutAt);
  if (!trimmedCustom) {
    return untilLabel;
  }

  return `${trimmedCustom} | ${untilLabel}`;
};

const normalizeStatus = (value: unknown): Status => {
  if (typeof value !== "object" || value === null) {
    return createStatus();
  }

  const now = new Date().toISOString();
  const candidate = value as Record<string, unknown>;
  const lastCheckIn =
    typeof candidate.last_check_in === "string" ? candidate.last_check_in : null;
  const checkInCount =
    typeof candidate.check_in_count === "number" && Number.isFinite(candidate.check_in_count)
      ? candidate.check_in_count
      : 0;
  const updatedAt =
    typeof candidate.updated_at === "string"
      ? candidate.updated_at
      : new Date().toISOString();
  const storedGymName = typeof candidate.gym_name === "string" ? candidate.gym_name : gymName;

  const rawPeople = Array.isArray(candidate.people_here) ? candidate.people_here : [];
  const peopleMap = new Map<string, PersonHere>();
  for (const person of rawPeople) {
    if (typeof person !== "object" || person === null) {
      continue;
    }

    const candidatePerson = person as Record<string, unknown>;
    if (typeof candidatePerson.name !== "string") {
      continue;
    }
    const normalized = normalizeName(candidatePerson.name);
    if (normalized.length === 0) {
      continue;
    }

    const entry: PersonHere = {
      name: normalized,
      checked_in_at:
        typeof candidatePerson.checked_in_at === "string"
          ? candidatePerson.checked_in_at
          : lastCheckIn ?? now
    };
    if (typeof candidatePerson.checkout_at === "string") {
      entry.checkout_at = candidatePerson.checkout_at;
    }
    if (Array.isArray(candidatePerson.notes)) {
      const validNotes = (candidatePerson.notes as unknown[])
        .filter((n): n is Record<string, unknown> =>
          typeof n === "object" && n !== null &&
          typeof (n as Record<string, unknown>).from === "string" &&
          typeof (n as Record<string, unknown>).text === "string"
        )
        .map((n) => ({ from: normalizeName(n.from as string), text: n.text as string }))
        .filter((n) => n.from.length > 0 && n.text.length > 0);
      if (validNotes.length > 0) entry.notes = validNotes;
    } else if (typeof candidatePerson.note === "string" && candidatePerson.note.length > 0) {
      // migrate old single-note format
      entry.notes = [{ from: normalized, text: candidatePerson.note }];
    }
    if (candidatePerson.reactions && typeof candidatePerson.reactions === "object") {
      entry.reactions = candidatePerson.reactions as Record<string, string[]>;
    }
    peopleMap.set(normalized.toLowerCase(), entry);
  }

  const peopleHere = [...peopleMap.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  return {
    gym_name: storedGymName,
    people_here: peopleHere,
    last_check_in: lastCheckIn,
    check_in_count: checkInCount,
    updated_at: updatedAt
  };
};

const kvPath = Deno.env.get("DENO_KV_PATH");
const kv = await Deno.openKv(kvPath);
const STATUS_KEY_PREFIX = ["status"];
const VAPID_KEYS_KV_KEY = ["vapid_keys"];
const PUSH_SUB_PREFIX = ["push_subscriptions"];

type VapidKeys = { publicKey: string; privateKey: string };
type StoredSubscription = {
  name: string;
  gym: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
};

async function initVapid(): Promise<VapidKeys> {
  const envPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const envPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  if (envPublic && envPrivate) {
    return { publicKey: envPublic, privateKey: envPrivate };
  }
  const entry = await kv.get<VapidKeys>(VAPID_KEYS_KV_KEY);
  if (entry.value) {
    return entry.value;
  }
  const keys = webpush.generateVAPIDKeys();
  await kv.set(VAPID_KEYS_KV_KEY, keys);
  console.log("generated new vapid keys (stored in kv)");
  return keys;
}
const vapidKeys = await initVapid();
const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:clymbe@example.com";
webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);

const pushStore = {
  async save(name: string, gym: string, subscription: StoredSubscription["subscription"]): Promise<void> {
    await kv.set([...PUSH_SUB_PREFIX, gym, subscription.endpoint], { name, gym, subscription });
  },
  async remove(gym: string, endpoint: string): Promise<void> {
    await kv.delete([...PUSH_SUB_PREFIX, gym, endpoint]);
  },
  async getAllForGym(gym: string): Promise<StoredSubscription[]> {
    const entries: StoredSubscription[] = [];
    for await (const entry of kv.list<StoredSubscription>({ prefix: [...PUSH_SUB_PREFIX, gym] })) {
      if (entry.value) entries.push(entry.value);
    }
    return entries;
  },
};

async function sendPresenceNotifications(gym: string, name: string, message: string): Promise<void> {
  const allSubs = await pushStore.getAllForGym(gym);
  const payload = JSON.stringify({
    title: "clymbe",
    body: message,
    url: "/",
  });

  const sends = allSubs
    .filter((s) => !namesEqual(s.name, name))
    .map(async (s) => {
      try {
        await webpush.sendNotification(s.subscription, payload);
      } catch (err: unknown) {
        const code = err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : 0;
        if (code === 410 || code === 404) {
          await pushStore.remove(gym, s.subscription.endpoint);
        } else {
          console.error(`push failed for ${s.name}:`, err);
        }
      }
    });

  await Promise.allSettled(sends);
}

async function sendReactionNotification(gym: string, reactorName: string, targetName: string): Promise<void> {
  const allSubs = await pushStore.getAllForGym(gym);
  const payload = JSON.stringify({
    title: "clymbe",
    body: `${reactorName} reacted to you`,
    url: "/",
  });

  const sends = allSubs
    .filter((s) => namesEqual(s.name, targetName))
    .map(async (s) => {
      try {
        await webpush.sendNotification(s.subscription, payload);
      } catch (err: unknown) {
        const code = err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : 0;
        if (code === 410 || code === 404) {
          await pushStore.remove(gym, s.subscription.endpoint);
        } else {
          console.error(`push failed for ${s.name}:`, err);
        }
      }
    });

  await Promise.allSettled(sends);
}

const ALLOWED_COLORS = ["#f9a8d4", "#a5b4fc", "#86efac", "#fde68a", "#c4b5fd"];

const store = {
  async read(gym: string): Promise<Status> {
    const entry = await kv.get<Status>([...STATUS_KEY_PREFIX, gym]);
    if (entry.value) {
      return normalizeStatus(entry.value);
    }
    const initial: Status = {
      gym_name: gym,
      people_here: [],
      last_check_in: null,
      check_in_count: 0,
      updated_at: new Date().toISOString()
    };
    await kv.set([...STATUS_KEY_PREFIX, gym], initial);
    return initial;
  },
  async write(gym: string, status: Status): Promise<void> {
    await kv.set([...STATUS_KEY_PREFIX, gym], status);
  },
  async setPresence(gym: string, name: string, isHere: boolean, note?: string, hours?: number): Promise<Status> {
    const normalizedName = normalizeName(name);
    if (normalizedName.length === 0) {
      throw new Error("name is required");
    }

    const current = await this.read(gym);
    const now = new Date().toISOString();
    const existingIndex = current.people_here.findIndex((person) =>
      namesEqual(person.name, normalizedName)
    );

    const peopleHere = [...current.people_here];
    const checkoutAt =
      hours && hours > 0
        ? new Date(new Date(now).getTime() + hours * 60 * 60 * 1000).toISOString()
        : undefined;
    const presenceNote = buildPresenceNote(note, checkoutAt);

    if (isHere && existingIndex === -1) {
      const entry: PersonHere = { name: normalizedName, checked_in_at: now };
      if (presenceNote) entry.notes = [{ from: normalizedName, text: presenceNote }];
      if (checkoutAt) entry.checkout_at = checkoutAt;
      peopleHere.push(entry);
    } else if (isHere && existingIndex !== -1) {
      const existing = peopleHere[existingIndex];
      const updatedNotes = existing.notes ? [...existing.notes] : [];
      if (presenceNote) {
        const selfIdx = updatedNotes.findIndex((n) => namesEqual(n.from, normalizedName));
        if (selfIdx !== -1) updatedNotes[selfIdx] = { from: normalizedName, text: presenceNote };
        else updatedNotes.push({ from: normalizedName, text: presenceNote });
      }
      peopleHere[existingIndex] = {
        ...existing,
        name: normalizedName,
        ...(checkoutAt ? { checkout_at: checkoutAt } : {}),
        ...(updatedNotes.length > 0 ? { notes: updatedNotes } : {})
      };
    } else if (!isHere && existingIndex !== -1) {
      peopleHere.splice(existingIndex, 1);
    }

    peopleHere.sort((left, right) => left.name.localeCompare(right.name));

    const next: Status = {
      ...current,
      people_here: peopleHere,
      updated_at: now
    };

    if (isHere && existingIndex === -1) {
      next.last_check_in = now;
      next.check_in_count = current.check_in_count + 1;
    }

    await this.write(gym, next);
    return next;
  },
  async addNote(gym: string, targetName: string, fromName: string, text: string): Promise<Status> {
    const normalizedTarget = normalizeName(targetName);
    const normalizedFrom = normalizeName(fromName);
    if (!normalizedTarget || !normalizedFrom || !text) {
      throw new Error("target, from, and text are required");
    }

    const current = await this.read(gym);
    const targetIndex = current.people_here.findIndex((p) =>
      namesEqual(p.name, normalizedTarget)
    );
    if (targetIndex === -1) {
      throw new Error("person is not checked in");
    }

    const person = { ...current.people_here[targetIndex] };
    const notes = person.notes ? [...person.notes] : [];
    // Replace existing note from this person, or add new
    const existingIdx = notes.findIndex((n) => namesEqual(n.from, normalizedFrom));
    const newNote = { from: normalizedFrom, text };
    if (existingIdx !== -1) {
      notes[existingIdx] = newNote;
    } else {
      notes.push(newNote);
    }
    person.notes = notes;

    const peopleHere = [...current.people_here];
    peopleHere[targetIndex] = person;

    const next: Status = { ...current, people_here: peopleHere, updated_at: new Date().toISOString() };
    await this.write(gym, next);
    return next;
  },
  async addReaction(gym: string, targetName: string, reactorName: string, emoji: string): Promise<Status> {
    const normalizedTarget = normalizeName(targetName);
    const normalizedReactor = normalizeName(reactorName);

    const current = await this.read(gym);
    const targetIndex = current.people_here.findIndex((p) =>
      namesEqual(p.name, normalizedTarget)
    );
    if (targetIndex === -1) {
      throw new Error("person is not checked in");
    }

    const person = { ...current.people_here[targetIndex] };
    const reactions = { ...(person.reactions || {}) };

    const reactors = reactions[emoji] ? [...reactions[emoji]] : [];

    const existingIdx = reactors.findIndex((r) => namesEqual(r, normalizedReactor));
    if (existingIdx !== -1) {
      reactors.splice(existingIdx, 1);
    } else {
      reactors.push(normalizedReactor);
    }

    if (reactors.length === 0) {
      delete reactions[emoji];
    } else {
      reactions[emoji] = reactors;
    }

    person.reactions = Object.keys(reactions).length > 0 ? reactions : undefined;

    const peopleHere = [...current.people_here];
    peopleHere[targetIndex] = person;

    const next: Status = { ...current, people_here: peopleHere, updated_at: new Date().toISOString() };
    await this.write(gym, next);
    return next;
  },
  async reset(gym: string): Promise<Status> {
    const next: Status = {
      gym_name: gym,
      people_here: [],
      last_check_in: null,
      check_in_count: 0,
      updated_at: new Date().toISOString()
    };
    await this.write(gym, next);
    return next;
  },
  async autoCheckout(gym: string): Promise<void> {
    const current = await this.read(gym);
    const now = new Date();
    const updated = current.people_here.filter((person) => {
      if (!person.checkout_at) return true;
      const checkoutTime = new Date(person.checkout_at);
      return now < checkoutTime;
    });

    if (updated.length !== current.people_here.length) {
      const next: Status = {
        ...current,
        people_here: updated,
        updated_at: new Date().toISOString()
      };
      await this.write(gym, next);
    }
  }
};

type Ctx = RouterContext<string>;
const router = new Router();

router.get("/api/status", async (ctx: Ctx) => {
  const gym = ctx.request.url.searchParams.get("gym") || gymName;
  await store.autoCheckout(gym);
  ctx.response.body = await store.read(gym);
});

router.post("/api/presence", async (ctx: Ctx) => {
  if (!ctx.request.hasBody) {
    ctx.response.status = 400;
    ctx.response.body = { message: "body required" };
    return;
  }

  let body: unknown;
  try {
    body = await ctx.request.body.json();
  } catch {
    ctx.response.status = 400;
    ctx.response.body = { message: "invalid json body" };
    return;
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).name !== "string" ||
    typeof (body as Record<string, unknown>).is_here !== "boolean" ||
    typeof (body as Record<string, unknown>).gym !== "string"
  ) {
    ctx.response.status = 400;
    ctx.response.body = { message: "body must include string gym, string name and boolean is_here" };
    return;
  }

  const payload = body as { name: string; gym: string; is_here: boolean; note?: unknown };
  const note = typeof payload.note === "string" ? payload.note.trim() : undefined;
  try {
    const hours = typeof (body as Record<string, unknown>).hours === "number" 
      ? (body as Record<string, unknown>).hours as number
      : undefined;
    const updatedStatus = await store.setPresence(payload.gym, payload.name, payload.is_here, note || undefined, hours);
    ctx.response.body = updatedStatus;

    if (payload.is_here) {
      const name = normalizeName(payload.name);
      const msg = note
        ? `${name} checked in: "${note}"`
        : `${name} just checked in`;
      sendPresenceNotifications(payload.gym, name, msg).catch((err) =>
        console.error("push notification batch error:", err)
      );
    }
  } catch (error) {
    ctx.response.status = 400;
    ctx.response.body = {
      message: error instanceof Error ? error.message : "invalid request"
    };
  }
});

router.post("/api/react", async (ctx: Ctx) => {
  if (!ctx.request.hasBody) {
    ctx.response.status = 400;
    ctx.response.body = { message: "body required" };
    return;
  }

  let body: unknown;
  try {
    body = await ctx.request.body.json();
  } catch {
    ctx.response.status = 400;
    ctx.response.body = { message: "invalid json body" };
    return;
  }

  const b = body as Record<string, unknown>;
  if (
    typeof b.gym !== "string" ||
    typeof b.reactor !== "string" ||
    typeof b.target !== "string" ||
    typeof b.emoji !== "string"
  ) {
    ctx.response.status = 400;
    ctx.response.body = { message: "body must include string gym, reactor, target, and emoji" };
    return;
  }

  if (!ALLOWED_COLORS.includes(b.emoji as string)) {
    ctx.response.status = 400;
    ctx.response.body = { message: "invalid reaction color" };
    return;
  }

  const reactor = normalizeName(b.reactor as string);
  const target = normalizeName(b.target as string);

  try {
    const updatedStatus = await store.addReaction(b.gym, target, reactor, b.emoji as string);
    ctx.response.body = updatedStatus;

    sendReactionNotification(b.gym, reactor, target).catch((err) =>
      console.error("reaction notification error:", err)
    );
  } catch (error) {
    ctx.response.status = 400;
    ctx.response.body = {
      message: error instanceof Error ? error.message : "invalid request",
    };
  }
});

router.post("/api/note", async (ctx: Ctx) => {
  if (!ctx.request.hasBody) {
    ctx.response.status = 400;
    ctx.response.body = { message: "body required" };
    return;
  }

  let body: unknown;
  try {
    body = await ctx.request.body.json();
  } catch {
    ctx.response.status = 400;
    ctx.response.body = { message: "invalid json body" };
    return;
  }

  const b = body as Record<string, unknown>;
  if (
    typeof b.from !== "string" ||
    typeof b.target !== "string" ||
    typeof b.text !== "string" ||
    typeof b.gym !== "string"
  ) {
    ctx.response.status = 400;
    ctx.response.body = { message: "body must include string from, target, and text" };
    return;
  }

  const gym = b.gym;
  const from = normalizeName(b.from as string);
  const target = normalizeName(b.target as string);
  const text = (b.text as string).trim();

  if (!text) {
    ctx.response.status = 400;
    ctx.response.body = { message: "text cannot be empty" };
    return;
  }

  try {
    const updatedStatus = await store.addNote(gym, target, from, text);
    ctx.response.body = updatedStatus;

    if (!namesEqual(from, target)) {
      sendReactionNotification(gym, from, target).catch((err) =>
        console.error("note notification error:", err)
      );
    }
  } catch (error) {
    ctx.response.status = 400;
    ctx.response.body = {
      message: error instanceof Error ? error.message : "invalid request",
    };
  }
});

router.post("/api/reset", async (ctx: Ctx) => {
  const gym = ctx.request.url.searchParams.get("gym") || gymName;
  ctx.response.body = await store.reset(gym);
});

router.get("/api/vapid-public-key", (ctx: Ctx) => {
  ctx.response.body = { publicKey: vapidKeys.publicKey };
});

router.post("/api/push/subscribe", async (ctx: Ctx) => {
  if (!ctx.request.hasBody) {
    ctx.response.status = 400;
    ctx.response.body = { message: "body required" };
    return;
  }

  let body: unknown;
  try {
    body = await ctx.request.body.json();
  } catch {
    ctx.response.status = 400;
    ctx.response.body = { message: "invalid json body" };
    return;
  }

  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || !b.name.trim() || b.gym !== "string") {
    ctx.response.status = 400;
    ctx.response.body = { message: "name is required" };
    return;
  }

  const sub = b.subscription as Record<string, unknown> | undefined;
  if (
    !sub ||
    typeof sub.endpoint !== "string" ||
    !sub.keys ||
    typeof (sub.keys as Record<string, unknown>).p256dh !== "string" ||
    typeof (sub.keys as Record<string, unknown>).auth !== "string"
  ) {
    ctx.response.status = 400;
    ctx.response.body = { message: "subscription with endpoint and keys (p256dh, auth) is required" };
    return;
  }

  await pushStore.save(normalizeName(b.name as string), b.gym, {
    endpoint: sub.endpoint as string,
    keys: {
      p256dh: (sub.keys as Record<string, unknown>).p256dh as string,
      auth: (sub.keys as Record<string, unknown>).auth as string,
    },
  });

  ctx.response.body = { subscribed: true };
});

router.post("/api/push/unsubscribe", async (ctx: Ctx) => {
  if (!ctx.request.hasBody) {
    ctx.response.status = 400;
    ctx.response.body = { message: "body required" };
    return;
  }

  let body: unknown;
  try {
    body = await ctx.request.body.json();
  } catch {
    ctx.response.status = 400;
    ctx.response.body = { message: "invalid json body" };
    return;
  }

  const b = body as Record<string, unknown>;
  if (typeof b.endpoint !== "string" ||
    typeof b.gym !== "string"
  ) {
    ctx.response.status = 400;
    ctx.response.body = { message: "endpoint is required" };
    return;
  }

  await pushStore.remove(b.gym, b.endpoint as string);
  ctx.response.body = { unsubscribed: true };
});

router.get("/api/healthz", (ctx: Ctx) => {
  ctx.response.body = { ok: true };
});

const app = new Application();

app.use(async (_ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error(err);
    _ctx.response.status = 500;
    _ctx.response.body = { message: "internal error" };
  }
});

app.use(router.allowedMethods(), router.routes());
app.use(async (ctx) => {
  if (!ctx.request.url.pathname.startsWith("/api")) {
    try {
      await send(ctx, ctx.request.url.pathname, {
        root: "static",
        index: "index.html"
      });
    } catch {
      ctx.response.status = 404;
      ctx.response.body = "not found";
    }
  }
});

// Auto-checkout cleanup task - runs every 30 seconds.
setInterval(async () => {
  try {
    const gyms = ["Vital Lower East Side", "Bouldering Project"];
    await Promise.all(gyms.map((gym) => store.autoCheckout(gym)));
  } catch (error) {
    console.error("auto-checkout cleanup error:", error);
  }
}, 30000);

await app.listen({ port });
