// ---------------------------------------------------------------------------
// AtlasNavigationBridge — connects the Atlas voice tools to the REAL router.
//
// Rendered inside <BrowserRouter>, this component hands react-router's own
// `navigate` function to the voice navigation bridge. Nothing else changes:
// the link tree, sidebar and routes are untouched. `navigate_atlas` therefore
// uses exactly the same navigation mechanism as a click in the UI.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { useNavigate } from "react-router";
import { registerAtlasNavigator } from "@/lib/atlas-voice/navigation";

export function AtlasNavigationBridge(): null {
  const navigate = useNavigate();

  useEffect(() => {
    return registerAtlasNavigator((path: string) => navigate(path));
  }, [navigate]);

  return null;
}

export default AtlasNavigationBridge;
