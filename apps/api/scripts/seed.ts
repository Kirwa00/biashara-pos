export {};
const api = process.env.API_URL ?? "http://localhost:8787";
const res = await fetch(`${api}/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ businessName: "Mama Mboga Wholesalers", ownerName: "Demo Owner", email: "owner@demo.ke", phone: "0712345678", password: "demo-password-1" }),
});
console.log(res.status, res.status === 201 ? "Seeded owner@demo.ke / demo-password-1" : await res.text());
