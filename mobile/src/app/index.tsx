import { Redirect } from "expo-router";

import { useAuth } from "@/auth";

/** The app's entry address: notebooks when signed in, sign-up otherwise (the logo leads to the welcome screen). */
export default function Index() {
  const { user } = useAuth();
  return <Redirect href={user ? "/notebooks" : "/sign-up"} />;
}
