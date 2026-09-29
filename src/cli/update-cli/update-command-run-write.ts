import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateRunWriteOptions } from "../../infra/update-run-write.async.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { UpdateCommandOptions } from "./shared.js";
import { retainMutableUpdateSignalWrite } from "./update-command-mutable-signals.js";

export function captureUpdateCommandRunWriteOptions(run: NonNullable<UpdateCommandOptions["run"]>) {
  const assertAccepting = () => {
    if (run.interrupted) {
      throw new UpdateRequesterRevokedError();
    }
  };
  assertAccepting();
  const { runId, env, executorFence, requesterAuthority } = run;
  const assertCurrent = () => {
    if (
      run.runId !== runId ||
      run.env !== env ||
      run.executorFence !== executorFence ||
      run.requesterAuthority !== requesterAuthority ||
      requesterAuthority?.isCurrent() === false
    ) {
      throw new UpdateRequesterRevokedError();
    }
    executorFence?.assertCurrent();
  };
  assertCurrent();
  const capturedEnv = cloneEnvWithPlatformSemantics(env);
  return {
    env: capturedEnv,
    context: captureOpenClawStateWorkerContext({ env: capturedEnv }),
    assertCurrent,
    assertAccepting,
    retainSettlement: (completion: Promise<void>) =>
      retainMutableUpdateSignalWrite(run, completion),
  } satisfies UpdateRunWriteOptions;
}
