import { withTenantContext } from '../src/lib/db.js';
import { users } from '@givernance/shared/schema';

async function run() {
  const TENANT_ID = "00000000-0000-0000-0000-0000000000c1";
  
  await withTenantContext(TENANT_ID, async (tx) => {
    try {
      await tx.insert(users).values([
        {
          orgId: TENANT_ID,
          email: "alice@npo.local",
          firstName: "Alice",
          lastName: "NPO",
          role: "org_admin",
          keycloakId: "00000000-0000-0000-0000-0000000000c2",
        },
        {
          orgId: TENANT_ID,
          email: "bob@npo.local",
          firstName: "Bob",
          lastName: "Staff",
          role: "user",
          keycloakId: "00000000-0000-0000-0000-0000000000c3",
        }
      ]);
      console.log("Inserted users into Demo NPO");
    } catch(err: any) {
      console.log("Users probably already exist or error:", err.message);
    }
  });
  process.exit(0);
}
run();
