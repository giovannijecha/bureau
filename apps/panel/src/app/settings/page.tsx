import { SettingsBody } from "./SettingsBody";

// The full-page route (deep-link / fallback). The sidebar normally opens Settings as a
// centered modal (see SettingsModal); this keeps /settings working as a real, linkable page.
export default function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
        <SettingsBody />
      </div>
    </div>
  );
}
