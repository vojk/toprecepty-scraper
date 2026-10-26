import {searchToprecepty} from "./findRecipe.ts";
import {scrapeToprecepty} from "./scrapeRecipe.ts";

const server = Bun.serve({
    // `routes` requires Bun v1.2.3+
    routes: {
        // Static routes
        "/api/status": new Response("OK"),

        "/api/recipe/find": {
            GET: async (request, server) => {
                const r = new URL(request.url).searchParams.get("q") ?? "";

                try {
                    const recepty = await searchToprecepty(r);
                    console.log(`Nalezeno ${recepty.length} ks receptů`);

                    return Response.json({found: recepty.length, results: recepty});
                } catch (e) {
                    return Response.json(e, { status: 500 })
                }
            },
        },
        "/api/recipe": {
            GET: async (request, server) => {
                const r = new URL(request.url).searchParams.get("q") ?? "";

                try {
                    const recept = await scrapeToprecepty(r);
                    return Response.json({recept});
                } catch (e) {
                    return Response.json(e, { status: 500 })
                }
            },
        }
    },

    // (optional) fallback for unmatched routes:
    // Required if Bun's version < 1.2.3
    fetch(req) {
        return new Response("Not Found", { status: 404 });
    },
});

console.log(`Server running at ${server.url}`);