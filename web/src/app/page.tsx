import { redirect } from "next/navigation";

// The app opens on the Demo tab by default. The full Live Credit Desk lives at
// /desk; this root route just forwards there.
export default function Home() {
  redirect("/demo");
}
