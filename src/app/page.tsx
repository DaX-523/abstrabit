import { redirect } from "next/navigation";

// There's no public landing page: the app is the dashboard. /dashboard sends
// signed-out visitors on to /login (proxy.ts for the no-cookie case, the
// page's own session check for an expired one).
export default function Home() {
  redirect("/dashboard");
}
