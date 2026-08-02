"use client";

import {
  getPresentationWidgetDefinition,
  type PresentationWidgetPlacement,
} from "@esbla/contracts";

export function SurfaceGeometryControls({
  disabled,
  onMove,
  onResize,
  placement,
}: Readonly<{
  disabled: boolean;
  onMove: (columnDelta: number, rowDelta: number) => void;
  onResize: (columnSpanDelta: number, rowSpanDelta: number) => void;
  placement: PresentationWidgetPlacement;
}>) {
  const definition = getPresentationWidgetDefinition(
    placement.widgetDefinitionId,
    placement.widgetDefinitionVersion,
  );
  const bounds = definition.layoutConstraints.desktop;
  const numericValue = (value: string, current: number): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : current;
  };

  return (
    <fieldset className="surface-editor-geometry" disabled={disabled}>
      <legend>Exact position and size</legend>
      <label>
        <span>Column</span>
        <input
          aria-label={`${definition.displayName} column`}
          inputMode="numeric"
          max={12 - placement.columnSpan + 1}
          min={1}
          onChange={(event) =>
            onMove(numericValue(event.currentTarget.value, placement.column) - placement.column, 0)
          }
          type="number"
          value={placement.column}
        />
      </label>
      <label>
        <span>Row</span>
        <input
          aria-label={`${definition.displayName} row`}
          inputMode="numeric"
          max={1_000}
          min={1}
          onChange={(event) =>
            onMove(0, numericValue(event.currentTarget.value, placement.row) - placement.row)
          }
          type="number"
          value={placement.row}
        />
      </label>
      <label>
        <span>Width</span>
        <input
          aria-label={`${definition.displayName} width in columns`}
          inputMode="numeric"
          max={Math.min(bounds.maximumColumnSpan, 12 - placement.column + 1)}
          min={bounds.minimumColumnSpan}
          onChange={(event) =>
            onResize(
              numericValue(event.currentTarget.value, placement.columnSpan) - placement.columnSpan,
              0,
            )
          }
          type="number"
          value={placement.columnSpan}
        />
      </label>
      <label>
        <span>Height</span>
        <input
          aria-label={`${definition.displayName} height in rows`}
          inputMode="numeric"
          max={bounds.maximumRowSpan}
          min={bounds.minimumRowSpan}
          onChange={(event) =>
            onResize(
              0,
              numericValue(event.currentTarget.value, placement.rowSpan) - placement.rowSpan,
            )
          }
          type="number"
          value={placement.rowSpan}
        />
      </label>
    </fieldset>
  );
}
