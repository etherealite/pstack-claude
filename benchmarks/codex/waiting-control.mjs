import { withControlledCodex } from "../../tests/codex/harness/controlled-workers.mjs";
import { defineWaitingTests } from "./support/waiting-suite.mjs";

defineWaitingTests({ withSession: withControlledCodex, workerMode: "controlled", control: true });
