FROM denoland/deno:latest

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install

COPY . .
RUN deno cache main.ts

EXPOSE 5353

ENV DENO_KV_PATH=/data/kv.db

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read=/data,static", "--allow-write=/data", "main.ts"]
