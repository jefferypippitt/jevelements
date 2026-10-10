// The Next.js app every capture ships as: what `create-next-app --yes` sets up (App Router, TypeScript,
// Tailwind CSS v4, the `@/*` alias, AGENTS.md), written out here so the zip is ready to open and run
// without the agent scaffolding anything. archive.ts adds public/ and PROMPT.md next to these files.

export interface ProjectNames {
  name: string // kebab-case folder and package name: "hero-section"
  component: string // PascalCase export: "HeroSection"
  file: string // components/<file>.tsx
}

export interface ScaffoldFile {
  path: string
  body: string
}

// Same versions as this backend, so a capture builds with the Next.js these templates were checked against.
const VERSIONS = {
  next: '16.3.6',
  react: '19.2.8',
  tailwind: '^4',
  typescript: '^5',
  typesNode: '^20',
  typesReact: '^19',
}

const AGENT_RULES = `<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in \`node_modules/next/dist/docs/\` (resolved from this file's directory; in monorepos the \`next\` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by \`next dev\` — verify at \`node_modules/next/dist/server/lib/generate-agent-files.js\`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->`

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function scaffold({ name, component, file }: ProjectNames): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      body: json({
        name,
        version: '0.1.0',
        private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { next: VERSIONS.next, react: VERSIONS.react, 'react-dom': VERSIONS.react },
        devDependencies: {
          '@tailwindcss/postcss': VERSIONS.tailwind,
          '@types/node': VERSIONS.typesNode,
          '@types/react': VERSIONS.typesReact,
          '@types/react-dom': VERSIONS.typesReact,
          tailwindcss: VERSIONS.tailwind,
          typescript: VERSIONS.typescript,
        },
      }),
    },
    {
      path: 'tsconfig.json',
      body: json({
        compilerOptions: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'react-jsx',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts', '.next/dev/types/**/*.ts', '**/*.mts'],
        exclude: ['node_modules'],
      }),
    },
    {
      path: 'next.config.ts',
      body: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`,
    },
    {
      path: 'postcss.config.mjs',
      body: `const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
`,
    },
    {
      path: '.gitignore',
      body: `/node_modules
/.next/
/out/
/build
next-env.d.ts
*.tsbuildinfo
.env*
.DS_Store
npm-debug.log*
`,
    },
    {
      path: 'AGENTS.md',
      body: `${AGENT_RULES}

Build the section described in \`PROMPT.md\` (a 1:1 rebuild) or \`REMIX.md\` (a redesign of it), whichever the user sends. This folder is already the app: its files from the original page are in \`public/\`.
`,
    },
    { path: 'CLAUDE.md', body: '@AGENTS.md\n' },
    { path: 'app/globals.css', body: '@import "tailwindcss";\n' },
    {
      path: 'app/layout.tsx',
      body: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "${component}",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      path: 'app/page.tsx',
      body: `import { ${component} } from "@/components/${file}";

export default function Home() {
  return (
    <main>
      <${component} />
    </main>
  );
}
`,
    },
    {
      path: `components/${file}.tsx`,
      body: `export function ${component}() {
  return <section />;
}
`,
    },
  ]
}
