import type { Plugin } from "vite";
import { blogPosts } from "../src/content/blogPosts";

/**
 * sitemap.xml and robots.txt, generated from src/content/blogPosts.ts on every build (and served live
 * by the dev server), so publishing a post updates the sitemap automatically.
 *
 * SITE_URL sets the public origin, e.g. SITE_URL=https://notestack.ai (set it in the Pages build env).
 */

const STATIC_PAGES: { path: string; priority: string; changefreq: string }[] = [
  { path: "/", priority: "1.0", changefreq: "weekly" },
  { path: "/pricing", priority: "0.8", changefreq: "monthly" },
  { path: "/blogs", priority: "0.9", changefreq: "weekly" },
];

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function sitemapXml(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  // Posts whose canonical lives elsewhere are left out, as the BlogPost type promises.
  const posts = blogPosts
    .filter((p) => !p.canonicalPath)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const newest = posts[0]?.publishedAt;
  const urls = [
    ...STATIC_PAGES.map((p) => ({
      loc: `${base}${p.path}`,
      lastmod: p.path === "/blogs" ? newest : undefined,
      changefreq: p.changefreq,
      priority: p.priority,
    })),
    ...posts.map((p) => ({
      loc: `${base}/blogs/${p.slug}`,
      lastmod: p.publishedAt,
      changefreq: "monthly",
      priority: "0.7",
    })),
  ];
  const body = urls
    .map((u) =>
      [
        "  <url>",
        `    <loc>${escapeXml(u.loc)}</loc>`,
        u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : "",
        `    <changefreq>${u.changefreq}</changefreq>`,
        `    <priority>${u.priority}</priority>`,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function robotsTxt(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /auth\nDisallow: /welcome\n\nSitemap: ${base}/sitemap.xml\n`;
}

export function sitemapPlugin(origin: string): Plugin {
  return {
    name: "notestack-sitemap",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapXml(origin) });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robotsTxt(origin) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/sitemap.xml") {
          res.setHeader("Content-Type", "application/xml; charset=utf-8");
          res.end(sitemapXml(origin));
        } else if (req.url === "/robots.txt") {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(robotsTxt(origin));
        } else {
          next();
        }
      });
    },
  };
}
