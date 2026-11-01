import { app } from "./app";
import { createSql } from "./db";
import type { Env } from "./env";
import { CRON_JOBS, runJob } from "./jobs";

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    const job = CRON_JOBS[event.cron];
    if (!job) return;
    const sql = createSql(env);
    ctx.waitUntil(runJob(env, sql, job, { now: new Date(event.scheduledTime) }).then((r) => console.log(`job ${job}`, r)).finally(() => sql.end({ timeout: 5 })));
  },
} satisfies ExportedHandler<Env>;
