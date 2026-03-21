import { Application, send } from "@oak/oak";
import { Router, RouterContext } from "@oak/oak/router";
import webpush from "web-push";

const port = Number(Deno.env.get("PORT") ?? "5353");
const gymName =
  (Deno.env.get("DEFAULT_CLYMBE_GYM_NAME") ?? "bouldering project")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

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

type StandardizedSessionDetails = {
  arrival_time_iso: string;
  duration_minutes: number;
  inferred_from_text: string;
};

type ParsedSessionDetails = StandardizedSessionDetails | null;

type ScheduledSessionStatus = "scheduled" | "checked_in" | "completed" | "cancelled";

type ScheduledSession = {
  id: string;
  gym: string;
  name: string;
  note?: string;
  details_text: string;
  standardized_details: StandardizedSessionDetails;
  start_at: string;
  end_at: string;
  status: ScheduledSessionStatus;
  created_at: string;
  updated_at: string;
  checked_in_at?: string;
  checked_out_at?: string;
};

const createStatus = (): Status => ({
  gym_name: gymName,
  people_here: [],
  last_check_in: null,
  check_in_count: 0,
  updated_at: new Date().toISOString()
});

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, " ");

const normalizeGym = (gym: string): string => gym.trim().replace(/\s+/g, " ").toLowerCase();

const namesEqual = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const buildPresenceNote = (customNote: string | undefined): string | undefined => {
  const trimmedCustom = customNote?.trim();
  return trimmedCustom || undefined;
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
  const storedGymName =
    typeof candidate.gym_name === "string" ? normalizeGym(candidate.gym_name) : gymName;

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
const SCHEDULED_SESSION_KEY_PREFIX = ["scheduled_sessions"];
const VAPID_KEYS_KV_KEY = ["vapid_keys"];
const PUSH_SUB_PREFIX = ["push_subscriptions"];
const SCHEDULE_REMINDER_SENT_PREFIX = ["schedule_reminder_sent"];

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")?.trim();
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL")?.trim() || "gemini-2.0-flash";

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

const isValidIsoDate = (value: string): boolean => !Number.isNaN(new Date(value).getTime());

const REMINDER_TIME_ZONE = "America/New_York";

const getDateKeyInTimeZone = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("failed to derive date key in timezone");
  }
  return `${year}-${month}-${day}`;
};

const addDaysToDateKey = (dateKey: string, days: number): string => {
  const [year, month, day] = dateKey.split("-").map((v) => Number(v));
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + days);
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, "0");
  const d = String(base.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getHourInTimeZone = (date: Date, timeZone: string): number => {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(hour);
};

const sanitizeGeminiJson = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

const buildGeminiPrompt = (input: {
  sessionDetails: string;
  nowIso: string;
  timezone: string;
}): string =>
  [
    "You convert natural language climbing session details into strict JSON.",
    `Current timestamp ISO: ${input.nowIso}`,
    `User timezone IANA: ${input.timezone}`,
    `User text: ${input.sessionDetails}`,
    "Output JSON ONLY with keys:",
    "- has_schedule (boolean)",
    "- arrival_time_iso (string ISO timestamp or null)",
    "- duration_minutes (positive integer or null)",
    "- inferred_from_text (string, concise interpretation of the schedule if present, otherwise empty string)",
    "Rules:",
    "- Resolve relative times against Current timestamp using provided timezone.",
    "- Only set has_schedule to true when the text clearly includes schedule information.",
    "- If the text is only a generic note with no date, time, or duration, set has_schedule to false and both arrival_time_iso and duration_minutes to null.",
    "- If the user gives only arrival and no duration, default duration_minutes to 60.",
    "- If the user gives only duration and no arrival, default arrival_time_iso to Current timestamp.",
    "- Keep inferred_from_text short and factual.",
  ].join("\n");

async function parseSessionDetailsWithGemini(input: {
  sessionDetails: string;
  nowIso: string;
  timezone: string;
}): Promise<ParsedSessionDetails> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(input) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1,
          },
        }),
      },
    );
  } catch {
    throw new Error("unable to reach session parser service");
  }

  if (!response.ok) {
    throw new Error(`session parser returned ${response.status}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const candidates = Array.isArray(data.candidates)
    ? data.candidates as Array<Record<string, unknown>>
    : [];
  const first = candidates[0];
  const content = first?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts) ? content?.parts as Array<Record<string, unknown>> : [];
  const text = parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("gemini did not return parseable content");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(sanitizeGeminiJson(text));
  } catch {
    throw new Error("gemini returned invalid JSON");
  }

  const arrival = typeof parsed.arrival_time_iso === "string"
    ? parsed.arrival_time_iso
    : "";
  const duration = typeof parsed.duration_minutes === "number"
    ? Math.floor(parsed.duration_minutes)
    : NaN;
  const hasSchedule = typeof parsed.has_schedule === "boolean"
    ? parsed.has_schedule
    : Boolean(arrival || Number.isFinite(duration));
  const interpreted = typeof parsed.inferred_from_text === "string"
    ? parsed.inferred_from_text.trim()
    : "";

  if (!hasSchedule) {
    return null;
  }

  if (!arrival || !isValidIsoDate(arrival)) {
    throw new Error("unable to parse arrival time from session details");
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60) {
    throw new Error("unable to parse a valid duration from session details");
  }

  return {
    arrival_time_iso: new Date(arrival).toISOString(),
    duration_minutes: duration,
    inferred_from_text: interpreted || input.sessionDetails,
  };
}

async function sendPushPayload(
  gym: string,
  target: StoredSubscription,
  payload: string,
): Promise<boolean> {
  try {
    await webpush.sendNotification(target.subscription, payload);
    return true;
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "statusCode" in err
      ? (err as { statusCode: number }).statusCode
      : 0;
    if (code === 410 || code === 404) {
      await pushStore.remove(gym, target.subscription.endpoint);
    } else {
      console.error(`push failed for ${target.name}:`, err);
    }
    return false;
  }
}

const pushStore = {
  async save(name: string, gym: string, subscription: StoredSubscription["subscription"]): Promise<void> {
    const normalizedGym = normalizeGym(gym);
    await kv.set([...PUSH_SUB_PREFIX, normalizedGym, subscription.endpoint], {
      name,
      gym: normalizedGym,
      subscription
    });
  },
  async remove(gym: string, endpoint: string): Promise<void> {
    await kv.delete([...PUSH_SUB_PREFIX, normalizeGym(gym), endpoint]);
  },
  async getAllForGym(gym: string): Promise<StoredSubscription[]> {
    const normalizedGym = normalizeGym(gym);
    const entries: StoredSubscription[] = [];
    for await (const entry of kv.list<StoredSubscription>({ prefix: [...PUSH_SUB_PREFIX, normalizedGym] })) {
      if (entry.value) entries.push(entry.value);
    }
    return entries;
  },
  async listGyms(): Promise<string[]> {
    const gyms = new Set<string>();
    for await (const entry of kv.list<StoredSubscription>({ prefix: PUSH_SUB_PREFIX })) {
      const key = entry.key;
      if (Array.isArray(key) && typeof key[1] === "string") {
        gyms.add(normalizeGym(key[1]));
      }
    }
    return [...gyms];
  },
};

const sessionStore = {
  async write(session: ScheduledSession): Promise<void> {
    await kv.set(
      [...SCHEDULED_SESSION_KEY_PREFIX, normalizeGym(session.gym), session.id],
      {
        ...session,
        gym: normalizeGym(session.gym),
        name: normalizeName(session.name),
      },
    );
  },
  async listAll(gym: string): Promise<ScheduledSession[]> {
    const normalizedGym = normalizeGym(gym);
    const sessions: ScheduledSession[] = [];
    for await (
      const entry of kv.list<ScheduledSession>({
        prefix: [...SCHEDULED_SESSION_KEY_PREFIX, normalizedGym],
      })
    ) {
      if (!entry.value) continue;
      const value = entry.value;
      if (!value.id || !value.name || !value.start_at || !value.end_at) continue;
      sessions.push({
        ...value,
        gym: normalizedGym,
        name: normalizeName(value.name),
      });
    }
    sessions.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
    return sessions;
  },
  async listFuture(gym: string, now = new Date()): Promise<ScheduledSession[]> {
    const sessions = await this.listAll(gym);
    const nowTs = now.getTime();
    return sessions.filter((session) =>
      session.status === "scheduled" && new Date(session.start_at).getTime() > nowTs
    );
  },
  async getById(gym: string, id: string): Promise<ScheduledSession | null> {
    const normalizedGym = normalizeGym(gym);
    const entry = await kv.get<ScheduledSession>([
      ...SCHEDULED_SESSION_KEY_PREFIX,
      normalizedGym,
      id,
    ]);
    if (!entry.value) return null;
    return {
      ...entry.value,
      gym: normalizedGym,
      name: normalizeName(entry.value.name),
    };
  },
  async listScheduledForNameOnDateKey(
    gym: string,
    name: string,
    dateKey: string,
    timeZone: string,
  ): Promise<ScheduledSession[]> {
    const normalizedName = normalizeName(name);
    const sessions = await this.listAll(gym);
    return sessions.filter((session) => {
      if (session.status !== "scheduled") return false;
      if (!namesEqual(session.name, normalizedName)) return false;
      const sessionDateKey = getDateKeyInTimeZone(new Date(session.start_at), timeZone);
      return sessionDateKey === dateKey;
    });
  },
};

const ALLOWED_COLORS = ["#f9a8d4", "#a5b4fc", "#86efac", "#fde68a", "#c4b5fd"];

const store = {
  async read(gym: string): Promise<Status> {
    const normalizedGym = normalizeGym(gym);
    const entry = await kv.get<Status>([...STATUS_KEY_PREFIX, normalizedGym]);
    if (entry.value) {
      return normalizeStatus(entry.value);
    }
    const initial: Status = {
      gym_name: normalizedGym,
      people_here: [],
      last_check_in: null,
      check_in_count: 0,
      updated_at: new Date().toISOString()
    };
    await kv.set([...STATUS_KEY_PREFIX, normalizedGym], initial);
    return initial;
  },
  async write(gym: string, status: Status): Promise<void> {
    const normalizedGym = normalizeGym(gym);
    await kv.set([...STATUS_KEY_PREFIX, normalizedGym], {
      ...status,
      gym_name: normalizeGym(status.gym_name)
    });
  },
  async setPresence(
    gym: string,
    name: string,
    isHere: boolean,
    note?: string,
    options?: { hours?: number; checkoutAtIso?: string; checkedInAtIso?: string },
  ): Promise<Status> {
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
      options?.checkoutAtIso && isValidIsoDate(options.checkoutAtIso)
        ? new Date(options.checkoutAtIso).toISOString()
        : options?.hours && options.hours > 0
        ? new Date(new Date(now).getTime() + options.hours * 60 * 60 * 1000).toISOString()
        : undefined;
    const presenceNote = buildPresenceNote(note);
    const effectiveCheckedInAt =
      options?.checkedInAtIso && isValidIsoDate(options.checkedInAtIso)
        ? new Date(options.checkedInAtIso).toISOString()
        : now;

    if (isHere && existingIndex === -1) {
      const entry: PersonHere = { name: normalizedName, checked_in_at: effectiveCheckedInAt };
      if (presenceNote) entry.notes = [{ from: normalizedName, text: presenceNote }];
      if (checkoutAt) entry.checkout_at = checkoutAt;
      peopleHere.push(entry);
    } else if (isHere && existingIndex !== -1) {
      const existing = peopleHere[existingIndex];
      const updatedNotes = existing.notes ? [...existing.notes] : [];
      const selfIdx = updatedNotes.findIndex((n) => namesEqual(n.from, normalizedName));
      if (presenceNote) {
        if (selfIdx !== -1) updatedNotes[selfIdx] = { from: normalizedName, text: presenceNote };
        else updatedNotes.push({ from: normalizedName, text: presenceNote });
      } else if (selfIdx !== -1) {
        updatedNotes.splice(selfIdx, 1);
      }
      const updatedPerson: PersonHere = {
        ...existing,
        name: normalizedName,
        ...(updatedNotes.length > 0 ? { notes: updatedNotes } : {})
      };
      if (checkoutAt) {
        updatedPerson.checkout_at = checkoutAt;
      } else {
        delete updatedPerson.checkout_at;
      }
      peopleHere[existingIndex] = updatedPerson;
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
  const gym = normalizeGym(ctx.request.url.searchParams.get("gym") || gymName);
  await processScheduledSessionsForGym(gym);
  await store.autoCheckout(gym);
  const status = await store.read(gym);
  const scheduledSessions = await sessionStore.listFuture(gym);
  ctx.response.body = { ...status, scheduled_sessions: scheduledSessions };
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
  const gym = normalizeGym(payload.gym);
  const note = typeof payload.note === "string" ? payload.note.trim() : undefined;
  try {
    const hours = typeof (body as Record<string, unknown>).hours === "number"
      ? (body as Record<string, unknown>).hours as number
      : undefined;
    const updatedStatus = await store.setPresence(
      gym,
      payload.name,
      payload.is_here,
      note || undefined,
      { hours },
    );
    ctx.response.body = updatedStatus;
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

  const gym = normalizeGym(b.gym as string);

  try {
    const updatedStatus = await store.addReaction(gym, target, reactor, b.emoji as string);
    ctx.response.body = updatedStatus;
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

  const gym = normalizeGym(b.gym as string);
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
  } catch (error) {
    ctx.response.status = 400;
    ctx.response.body = {
      message: error instanceof Error ? error.message : "invalid request",
    };
  }
});

router.post("/api/reset", async (ctx: Ctx) => {
  const gym = normalizeGym(ctx.request.url.searchParams.get("gym") || gymName);
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

  await pushStore.save(normalizeName(b.name as string), normalizeGym(b.gym as string), {
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

  await pushStore.remove(normalizeGym(b.gym as string), b.endpoint as string);
  ctx.response.body = { unsubscribed: true };
});

router.get("/api/sessions", async (ctx: Ctx) => {
  const gym = normalizeGym(ctx.request.url.searchParams.get("gym") || gymName);
  await processScheduledSessionsForGym(gym);
  ctx.response.body = { sessions: await sessionStore.listFuture(gym) };
});

router.post("/api/sessions/add", async (ctx: Ctx) => {
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
  if (typeof b.gym !== "string" || typeof b.name !== "string") {
    ctx.response.status = 400;
    ctx.response.body = { message: "body must include string gym and string name" };
    return;
  }

  const gym = normalizeGym(b.gym as string);
  const name = normalizeName(b.name as string);
  const note = typeof b.note === "string" ? b.note.trim() : "";
  const sessionDetails = typeof b.session_details === "string" ? b.session_details.trim() : "";
  const schedulingText = sessionDetails || note;
  const nowIsoInput = typeof b.now_iso === "string" && isValidIsoDate(b.now_iso)
    ? new Date(b.now_iso).toISOString()
    : new Date().toISOString();
  const timezone = typeof b.timezone === "string" && b.timezone.trim()
    ? b.timezone.trim()
    : "UTC";

  if (!name) {
    ctx.response.status = 400;
    ctx.response.body = { message: "name is required" };
    return;
  }

  const checkInNowForOneHour = async (reason: string) => {
    const start = new Date(nowIsoInput);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const status = await store.setPresence(gym, name, true, note || undefined, {
      checkoutAtIso: end.toISOString(),
      checkedInAtIso: start.toISOString(),
    });
    ctx.response.body = {
      status,
      scheduled_session: null,
      standardized_details: {
        arrival_time_iso: start.toISOString(),
        duration_minutes: 60,
        inferred_from_text: reason,
      },
    };
  };

  try {
    if (!schedulingText) {
      await checkInNowForOneHour("no scheduling details provided; defaulted to 60 minutes");
      return;
    }

    const standardizedDetails = await parseSessionDetailsWithGemini({
      sessionDetails: schedulingText,
      nowIso: nowIsoInput,
      timezone,
    });

    if (!standardizedDetails) {
      await checkInNowForOneHour("no schedule found in note; defaulted to 60 minutes");
      return;
    }

    const sessionStart = new Date(standardizedDetails.arrival_time_iso);
    const sessionEnd = new Date(
      sessionStart.getTime() + standardizedDetails.duration_minutes * 60 * 1000,
    );
    const now = new Date(nowIsoInput);
    if (sessionEnd.getTime() <= now.getTime()) {
      throw new Error("session end time must be in the future");
    }

    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();

    const session: ScheduledSession = {
      id,
      gym,
      name,
      ...(note ? { note } : {}),
      details_text: schedulingText,
      standardized_details: standardizedDetails,
      start_at: sessionStart.toISOString(),
      end_at: sessionEnd.toISOString(),
      status: sessionStart.getTime() <= now.getTime() ? "checked_in" : "scheduled",
      created_at: createdAt,
      updated_at: createdAt,
    };

    if (session.status === "checked_in") {
      const updatedStatus = await store.setPresence(gym, name, true, note || undefined, {
        checkoutAtIso: session.end_at,
        checkedInAtIso: now.toISOString(),
      });
      session.checked_in_at = now.toISOString();
      await sessionStore.write(session);
      ctx.response.body = {
        status: updatedStatus,
        scheduled_session: session,
        standardized_details: standardizedDetails,
      };
      return;
    }

    await sessionStore.write(session);
    await processScheduledSessionsForGym(gym);
    const status = await store.read(gym);
    ctx.response.body = {
      status,
      scheduled_session: session,
      standardized_details: standardizedDetails,
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "invalid request";
    const safeClientMessage = [
      "session end time must be in the future",
      "unable to parse arrival time from session details",
      "unable to parse a valid duration from session details",
      "gemini returned invalid JSON",
      "gemini did not return parseable content",
      "unable to reach session parser service",
      "GEMINI_API_KEY is not configured",
    ].includes(rawMessage)
      ? rawMessage
      : "unable to parse session details right now";

    ctx.response.status = 400;
    ctx.response.body = {
      message: safeClientMessage,
    };
  }
});

router.post("/api/sessions/cancel", async (ctx: Ctx) => {
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
  if (typeof b.gym !== "string" || typeof b.name !== "string" || typeof b.session_id !== "string") {
    ctx.response.status = 400;
    ctx.response.body = { message: "body must include string gym, name, and session_id" };
    return;
  }

  const gym = normalizeGym(b.gym as string);
  const name = normalizeName(b.name as string);
  const sessionId = (b.session_id as string).trim();

  const existing = await sessionStore.getById(gym, sessionId);
  if (!existing) {
    ctx.response.status = 404;
    ctx.response.body = { message: "scheduled session not found" };
    return;
  }

  if (!namesEqual(existing.name, name)) {
    ctx.response.status = 403;
    ctx.response.body = { message: "you can only cancel your own scheduled sessions" };
    return;
  }

  if (existing.status !== "scheduled") {
    ctx.response.status = 400;
    ctx.response.body = { message: "only future scheduled sessions can be cancelled" };
    return;
  }

  const next: ScheduledSession = {
    ...existing,
    status: "cancelled",
    updated_at: new Date().toISOString(),
  };

  await sessionStore.write(next);
  const status = await store.read(gym);
  ctx.response.body = { status, cancelled_session_id: sessionId };
});

router.get("/api/healthz", (ctx: Ctx) => {
  ctx.response.body = { ok: true };
});

async function processScheduledSessionsForGym(gym: string): Promise<void> {
  const sessions = await sessionStore.listAll(gym);
  const now = new Date();
  const nowTs = now.getTime();

  for (const session of sessions) {
    const startTs = new Date(session.start_at).getTime();
    const endTs = new Date(session.end_at).getTime();

    if (session.status === "scheduled" && startTs <= nowTs) {
      await store.setPresence(gym, session.name, true, session.note, {
        checkoutAtIso: session.end_at,
        checkedInAtIso: new Date(Math.max(startTs, nowTs)).toISOString(),
      });
      session.status = "checked_in";
      session.checked_in_at = now.toISOString();
      session.updated_at = new Date().toISOString();
      await sessionStore.write(session);
    }

    if (session.status === "checked_in" && endTs <= nowTs) {
      await store.setPresence(gym, session.name, false);
      session.status = "completed";
      session.checked_out_at = now.toISOString();
      session.updated_at = new Date().toISOString();
      await sessionStore.write(session);
    }
  }
}

async function listKnownGyms(): Promise<string[]> {
  const gyms = new Set<string>([gymName]);

  for await (const entry of kv.list({ prefix: STATUS_KEY_PREFIX })) {
    if (Array.isArray(entry.key) && typeof entry.key[1] === "string") {
      gyms.add(normalizeGym(entry.key[1]));
    }
  }

  for await (const entry of kv.list({ prefix: SCHEDULED_SESSION_KEY_PREFIX })) {
    if (Array.isArray(entry.key) && typeof entry.key[1] === "string") {
      gyms.add(normalizeGym(entry.key[1]));
    }
  }

  const pushGyms = await pushStore.listGyms();
  for (const gym of pushGyms) {
    gyms.add(normalizeGym(gym));
  }

  return [...gyms];
}

async function sendTomorrowScheduleReminders(): Promise<void> {
  const now = new Date();
  if (getHourInTimeZone(now, REMINDER_TIME_ZONE) !== 19) {
    return;
  }

  const localDateKey = getDateKeyInTimeZone(now, REMINDER_TIME_ZONE);
  const tomorrowDateKey = addDaysToDateKey(localDateKey, 1);
  const gyms = await listKnownGyms();

  for (const gym of gyms) {
    const subscriptions = await pushStore.getAllForGym(gym);
    if (subscriptions.length === 0) continue;

    for (const sub of subscriptions) {
      const reminderKey = [
        ...SCHEDULE_REMINDER_SENT_PREFIX,
        normalizeGym(gym),
        localDateKey,
        sub.subscription.endpoint,
      ];
      const sent = await kv.get<boolean>(reminderKey);
      if (sent.value) continue;

      const sessions = await sessionStore.listScheduledForNameOnDateKey(
        gym,
        sub.name,
        tomorrowDateKey,
        REMINDER_TIME_ZONE,
      );
      if (sessions.length === 0) continue;

      const payload = JSON.stringify({
        title: "clymbe",
        body: `You have ${sessions.length} scheduled climbing session${sessions.length === 1 ? "" : "s"} tomorrow at ${gym}.`,
        url: "/",
      });

      const sentOk = await sendPushPayload(gym, sub, payload);
      if (sentOk) {
        await kv.set(reminderKey, true);
      }
    }
  }
}

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

// Background scheduler for check-in/out lifecycle and reminder sends.
setInterval(async () => {
  try {
    const gyms = await listKnownGyms();
    await Promise.all(gyms.map(async (gym) => {
      await processScheduledSessionsForGym(gym);
      await store.autoCheckout(gym);
    }));
    await sendTomorrowScheduleReminders();
  } catch (error) {
    console.error("background scheduler error:", error);
  }
}, 30000);

await app.listen({ port });
