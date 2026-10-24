import { withControlledCodex } from "./harness/controlled-workers.mjs";
import { defineWaitingTests } from "./waiting-suite.mjs";

defineWaitingTests({ withSession: withControlledCodex, workerMode: "controlled" });
