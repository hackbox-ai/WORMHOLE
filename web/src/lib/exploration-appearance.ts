import { Bug, Compass, Flag, FlaskConical, Layers, Lightbulb, Target } from "lucide-react";
export const explorationAppearance = {
  task: { label: "Task", icon: Flag, hex: "#738092" },
  begin: { label: "Starting point", icon: Flag, hex: "#738092" },
  goal: { label: "Target", icon: Target, hex: "#758b7b" },
  intent: { label: "Execution steps", icon: Compass, hex: "#70849c" },
  fact: { label: "Facts", icon: FlaskConical, hex: "#a08a69" },
  finding: { label: "Discovery", icon: Bug, hex: "#a27a7c" },
  hint: { label: "Manual prompt", icon: Lightbulb, hex: "#9382a2" },
  digest: { label: "Stage Summary", icon: Layers, hex: "#73938e" },
};
