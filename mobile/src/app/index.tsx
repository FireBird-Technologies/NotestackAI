import { Redirect } from "expo-router";

import { useAuth } from "@/auth";

/** The app's entry address: notebooks when signed in, the welcome screen otherwise. */
export default function Index() {
  const { user } = useAuth();
  return <Redirect href={user ? "/notebooks" : "/welcome"} />;
}
