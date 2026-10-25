import { withControlledCodex } from "../../tests/codex/harness/controlled-workers.mjs";
import { defineWaitingTests } from "./support/waiting-suite.mjs";

const progressMessages = [
  { atMs: 10000, text: "Review in progress. Final findings will follow." },
  { atMs: 25000, text: "Checking the remaining counting argument. Review remains active." },
];

defineWaitingTests({
  withSession: (callback, options) => withControlledCodex(callback, { ...options, progressMessages }),
  workerMode: "controlled", mailboxCondition: "ordinary-message",
});
