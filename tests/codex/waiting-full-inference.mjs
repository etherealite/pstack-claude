import { withCodex } from "./harness/harness.mjs";
import { defineWaitingTests } from "./waiting-suite.mjs";

defineWaitingTests({ withSession: withCodex, workerMode: "full-inference" });
