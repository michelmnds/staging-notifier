import StagingDashboard from "@/components/staging-dashboard";
import users from "@/data/users.json";
import { getStagingState } from "@/lib/staging-state";
import type { User } from "@/types/user";

const allUsers = users as User[];
export const dynamic = "force-dynamic";

export default async function Home() {
  const state = await getStagingState();

  return (
    <StagingDashboard
      users={allUsers}
      initialAssignments={state.assignments}
    />
  );
}
