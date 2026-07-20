import type { InlineVisualization, VisualizationEngine } from "../types";

export function visualizationEngine(
  visualization: Pick<InlineVisualization, "engine">,
): VisualizationEngine {
  return visualization.engine === "tikz" ? "tikz" : "metapost";
}

export function visualizationSource(
  visualization: Pick<InlineVisualization, "source" | "metapostSource">,
): string {
  return visualization.source ?? visualization.metapostSource ?? "";
}

export function visualizationEngineLabel(engine: VisualizationEngine): string {
  return engine === "tikz" ? "TikZ" : "MetaPost";
}
