/**
 * Extension point for feature commands. Each feature module exports a
 * Record<string, Command>; add ONE import line and ONE spread line below.
 * (Keeps parallel feature work from editing registry.ts concurrently.)
 */
import type { Command } from "./registry.ts";
import { candidateCommands } from "./commands/candidates.ts";
import { previewCommands } from "./commands/preview.ts";
import { reviseCommands } from "./commands/revise.ts";
import { exportCommands } from "./commands/export.ts";
import { creatorCommands } from "./commands/creator.ts";
import { luxuryCommands } from "./commands/luxury.ts";
import { directorCommands } from "./commands/director.ts";
import { styleCommands } from "./commands/style.ts";
import { reviewCommands } from "./commands/review.ts";
import { captureCommands } from "./commands/capture.ts";

export const EXT_COMMANDS: Record<string, Command> = {
  ...candidateCommands,
  ...previewCommands,
  ...reviseCommands,
  ...exportCommands,
  ...creatorCommands,
  ...luxuryCommands,
  ...directorCommands,
  ...styleCommands,
  ...reviewCommands,
  ...captureCommands,
};
