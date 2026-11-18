// Mock Switch. Public variables injected during build time（NEXT_PUBLIC_ The prefix is only readable by the browser）。
// Vercel supra NEXT_PUBLIC_MOCK=1 Walk the entire station mock、No backend required。
export const MOCK = process.env.NEXT_PUBLIC_MOCK === "1";
