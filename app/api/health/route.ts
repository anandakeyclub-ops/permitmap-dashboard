// Lightweight health/observability endpoint. Reports whether the critical env
// vars are present in this deployment (booleans only — never leak values).
//   curl https://<deployment>/api/health
export async function GET() {
  return Response.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      clerk: !!process.env.CLERK_SECRET_KEY,
      api_url: !!process.env.NEXT_PUBLIC_API_URL,
    },
  })
}
