import { withCodex } from "../../tests/codex/harness/harness.mjs";
import { defineWaitingTests } from "./support/waiting-suite.mjs";

defineWaitingTests({ withSession: withCodex, workerMode: "full-inference" });
