import { getPresentationSemanticSurfaceDefinition, parseZenV1SurfaceId } from "@esbla/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadTenantPresentationSurfaceBaseWorkspace } from "../../../../../lib/presentation-surface-bases";
import { getSurfaceDefinition } from "../../../../../theme/zen-theme/v1";
import { WorkspaceShell } from "../../../../workspace-shell";
import { TenantSurfaceEditor } from "./tenant-surface-editor";

export const dynamic = "force-dynamic";

export default async function TenantSurfaceEditorPage({
  params,
}: Readonly<{ params: Promise<{ surfaceId: string }> }>) {
  let surfaceId: ReturnType<typeof parseZenV1SurfaceId>;
  try {
    surfaceId = parseZenV1SurfaceId((await params).surfaceId);
  } catch {
    notFound();
  }
  const definition = getSurfaceDefinition(surfaceId);
  const workspace = await loadTenantPresentationSurfaceBaseWorkspace(surfaceId).catch(
    () => undefined,
  );
  const surfaceName = getPresentationSemanticSurfaceDefinition(surfaceId).label;

  return (
    <WorkspaceShell currentSurface={surfaceId} shortcutSurfaceId={surfaceId}>
      <div className="surface-editor-page" id="surface-editor-content">
        <nav
          aria-label="Surface editor breadcrumb"
          className="surface-editor-breadcrumb"
          data-zen-scroll-anchor="surface-editor-breadcrumb"
          data-zen-scroll-label="Surface editor location"
        >
          <Link href={definition.route}>{surfaceName}</Link>
          <span aria-hidden="true">/</span>
          <span>Tenant base</span>
        </nav>
        {workspace?.actions.canDraft ? (
          <TenantSurfaceEditor
            initialWorkspace={workspace}
            returnHref={definition.route}
            surfaceName={surfaceName}
          />
        ) : (
          <section
            className="surface-editor-unavailable"
            data-zen-scroll-anchor="surface-editor-unavailable"
            data-zen-scroll-label="Tenant Base editor unavailable"
            role="alert"
          >
            <p className="surface-label">Studio · Tenant base</p>
            <h1>Tenant Base editor unavailable</h1>
            <p>
              This editor is not available in your current context. No private policy detail is
              shown and nothing was changed.
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
