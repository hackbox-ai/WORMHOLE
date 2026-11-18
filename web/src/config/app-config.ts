import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "WORMHOLE",
  version: packageJson.version,
  copyright: `© ${currentYear}, WORMHOLE.`,
  meta: {
    title: "WORMHOLE",
    description: "LLM-driven autonomous penetration testing system console",
  },
};
