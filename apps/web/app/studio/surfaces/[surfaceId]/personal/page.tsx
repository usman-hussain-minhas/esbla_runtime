import { getPresentationSemanticSurfaceDefinition, parseZenV1SurfaceId } from "@esbla/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadOwnPresentationPersonalSurfaceEditorWorkspace } from "../../../../../lib/presentation-surfaces";
import { getSurfaceDefinition } from "../../../../../theme/zen-theme/v1";
import { WorkspaceShell } from "../../../../workspace-shell";
import { PersonalSurfaceEditor } from "./personal-surface-editor";

export const dynamic = "force-dynamic";

export default async function PersonalSurfaceEditorPage({
  params,
}: Readonly<{ params: Promise<{ surfaceId: string }> }>) {
  let surfaceId: ReturnType<typeof parseZenV1SurfaceId>;
  try {
    surfaceId = parseZenV1SurfaceId((await params).surfaceId);
  } catch {
    notFound();
  }
  const definition = getSurfaceDefinition(surfaceId);
  const workspace = await loadOwnPresentationPersonalSurfaceEditorWorkspace(surfaceId).catch(
    () => undefined,
  );
  const surfaceName = getPresentationSemanticSurfaceDefinition(surfaceId).label;

  return (
    <WorkspaceShell
      currentSurface={surfaceId === "surface.mission-control" ? "Mission Control" : "HR"}
    >
      <div className="surface-editor-page" id="surface-editor-content">
        <nav
          aria-label="Surface editor breadcrumb"
          className="surface-editor-breadcrumb"
          data-zen-scroll-anchor="surface-editor-breadcrumb"
          data-zen-scroll-label="Surface editor location"
        >
          <Link href={definition.route}>{surfaceName}</Link>
          <span aria-hidden="true">/</span>
          <span>Personal layout</span>
        </nav>
        {workspace ? (
          <PersonalSurfaceEditor
            initialWorkspace={workspace}
            returnHref={definition.route}
            surfaceName={surfaceName}
          />
        ) : (
          <section
            className="surface-editor-unavailable"
            data-zen-scroll-anchor="surface-editor-unavailable"
            data-zen-scroll-label="Layout editor unavailable"
            role="alert"
          >
            <p className="surface-label">Studio · Personal layout</p>
            <h1>Layout editor unavailable</h1>
            <p>
              Your surface could not be loaded. No private error detail is shown and nothing was
              changed.
            </p>
            <Link className="surface-editor-text-link" href={definition.route}>
              Return to {surfaceName}
            </Link>
          </section>
        )}
      </div>
    </WorkspaceShell>
  );
}
