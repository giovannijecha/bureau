"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSettingsModal } from "../../components/SettingsModal";

// Settings is a modal now — there is no standalone Settings page. This alias keeps the
// /settings URL working (old links / bookmarks): it opens the modal and replaces the URL
// with home, so you never land on an orphaned full-page copy of Settings.
export default function SettingsRoute() {
  const router = useRouter();
  const { open } = useSettingsModal();
  useEffect(() => {
    open();
    router.replace("/");
  }, [open, router]);
  return null;
}
