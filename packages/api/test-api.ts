import { SignJWT } from "jose";

async function run() {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET || "ci-test-secret-do-not-use-in-production");
  const token = await new SignJWT({
    sub: "test-user",
    email: "admin@givernance.org",
    org_id: "00000000-0000-0000-0000-0000000000a1",
    role: "org_admin",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(secret);

  const res = await fetch("http://localhost:4000/v1/admin/tenants/00000000-0000-0000-0000-0000000000a1", {
    headers: {
      cookie: `givernance_jwt=${token}`
    }
  });

  console.log(res.status, await res.text());
}
run();
