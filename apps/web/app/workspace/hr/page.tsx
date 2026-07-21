import { ArrowRight, CalendarDays, ContactRound, Settings2, UserPlus } from "lucide-react";

const services = [
  {
    description: "View your linked workforce identity and current workforce status.",
    href: "/workspace/hr/profile",
    icon: ContactRound,
    label: "Workforce profile",
  },
  {
    description: "Submit and follow whole-day leave requests.",
    href: "/workspace/hr/leave",
    icon: CalendarDays,
    label: "Leave requests",
  },
  {
    description: "HR operators create, link, and activate worker identities.",
    href: "/workspace/hr/profile/admin",
    icon: UserPlus,
    label: "Manage workforce profiles",
  },
  {
    description: "Tenant administrators control Workforce Profile activation.",
    href: "/workspace/hr/profile/settings",
    icon: Settings2,
    label: "Workforce service control",
  },
] as const;

export default function HrHubPage() {
  return (
    <section aria-labelledby="hr-hub-heading" className="work-surface hr-hub-surface">
      <header className="surface-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="hr-hub-heading">Human resources</h1>
          <p className="surface-summary">Your admitted HR services in one place.</p>
        </div>
      </header>

      <div className="hr-service-list">
        {services.map(({ description, href, icon: Icon, label }) => (
          <a className="hr-service-link" href={href} key={href}>
            <span aria-hidden="true" className="hr-service-icon">
              <Icon size={22} strokeWidth={1.7} />
            </span>
            <span className="hr-service-copy">
              <strong>{label}</strong>
              <span>{description}</span>
            </span>
            <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
          </a>
        ))}
      </div>
    </section>
  );
}
