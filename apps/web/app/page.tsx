import { Bell, BriefcaseBusiness, Inbox, Search, Settings } from "lucide-react";

export default function WorkspacePage() {
  return (
    <main className="workspace-shell">
      <aside aria-label="Workspace navigation" className="sidebar">
        <a aria-label="Esbla home" className="brand" href="/">
          <span className="brand-full">Esbla</span>
          <span aria-hidden="true" className="brand-mark">
            E
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <a aria-current="page" aria-label="My Work" className="nav-item" href="/">
            <Inbox aria-hidden="true" size={18} strokeWidth={1.8} />
            <span>My Work</span>
          </a>
          <button
            aria-label="HR, not available yet"
            className="nav-item"
            disabled
            title="HR is not active yet"
            type="button"
          >
            <BriefcaseBusiness aria-hidden="true" size={18} strokeWidth={1.8} />
            <span>HR</span>
          </button>
        </nav>
        <button
          aria-label="Settings, not available yet"
          className="icon-button sidebar-settings"
          disabled
          title="Settings are not available yet"
          type="button"
        >
          <Settings aria-hidden="true" size={19} />
        </button>
      </aside>

      <section className="work-area">
        <header className="topbar">
          <div className="search-field">
            <Search aria-hidden="true" size={18} />
            <input
              aria-label="Search, not available yet"
              disabled
              placeholder="Search"
              type="search"
            />
          </div>
          <button
            aria-label="Notifications, not available yet"
            className="icon-button"
            disabled
            title="Notifications are not available yet"
            type="button"
          >
            <Bell aria-hidden="true" size={19} />
          </button>
          <div aria-label="Signed in user" className="avatar" role="img">
            UH
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">Workspace</p>
              <h1>My Work</h1>
            </div>
            <span className="status-pill">0 open</span>
          </div>

          <div className="empty-state">
            <div className="empty-icon">
              <Inbox aria-hidden="true" size={28} strokeWidth={1.6} />
            </div>
            <h2>Nothing needs your attention</h2>
            <p>Assigned work and approvals will appear here.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
