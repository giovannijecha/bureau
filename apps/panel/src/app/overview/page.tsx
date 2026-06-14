import { permanentRedirect } from "next/navigation";

// Overview was merged into the Hub — it's now the single command center. Keep this
// route as a permanent (308) redirect so old links/bookmarks still land somewhere right.
export default function OverviewPage() {
  permanentRedirect("/hub");
}
