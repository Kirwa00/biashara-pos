import { app } from "./app";
import { runBillingJob } from "./billing";
import { createSql } from "./db";
import type { Env } from "./env";
import { processEtimsQueue } from "./etims";
import { CRON_JOBS, runJob } from "./jobs";

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    const job = CRON_JOBS[event.cron];
    if (!job) return;
    const sql = createSql(env);
    const now = new Date(event.scheduledTime);
    const work = async () => {
      console.log(`job ${job}`, await (job === "etims" ? processEtimsQueue(env, sql) : runJob(env, sql, job, { now })));
      if (job === "morning") console.log("job billing", await runBillingJob(env, sql, { now }));
    };
    ctx.waitUntil(work().finally(() => sql.end({ timeout: 5 })));
  },
} satisfies ExportedHandler<Env>;
