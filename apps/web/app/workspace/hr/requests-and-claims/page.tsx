import { renderZenRegisteredSurface } from "../../../../theme/zen-theme/v1/surfaces/zen-registered-surface";

export const dynamic = "force-dynamic";

export default async function HrRequestsAndClaimsPage() {
  return await renderZenRegisteredSurface("surface.hr.requests-and-claims");
}
