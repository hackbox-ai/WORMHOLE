"use client";
import * as React from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

/** Runtime motion is limited to live, visible work edges. The graph state and
 * relationship labels remain usable with motion disabled or reduced motion. */
export const PathEdge = React.memo(function PathEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  label,
  style,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.38,
  });
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {data?.flowing === true && (
        <circle r="2.5" fill="var(--path-running)" className="path-flow-particle" aria-hidden="true">
          <animateMotion path={edgePath} dur="2.5s" repeatCount="indefinite" />
        </circle>
      )}
      {label && (
        <EdgeLabelRenderer>
          <span
            className="path-edge-label nodrag nopan"
            style={{
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
              opacity: typeof style?.opacity === "number" ? Math.max(0.45, style.opacity) : 1,
            }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
