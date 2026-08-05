export const ZEN_SURFACE_FOCUS_HOST_ID = "zen-surface-focus-host-v1";

export function ZenSurfaceFocusHost() {
  return (
    <div
      className="zen-surface-focus-host"
      data-zen-surface-focus-host="true"
      id={ZEN_SURFACE_FOCUS_HOST_ID}
    />
  );
}
