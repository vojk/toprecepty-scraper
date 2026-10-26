import * as cheerio from "cheerio";

export interface RecipeSearchResult {
    title: string;
    url: string;
    imageUrl: string;
    score: number;
}

export class SearchFetchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SearchFetchError";
    }
}

function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function makeAbsoluteUrl(pathOrUrl: string, baseUrl: string = "https://www.toprecepty.cz"): string {
    if (pathOrUrl.startsWith("http")) return pathOrUrl;
    const cleanPath = pathOrUrl.startsWith("/") ? pathOrUrl.slice(1) : pathOrUrl;
    return `${baseUrl}/${cleanPath}`;
}

export async function searchToprecepty(query: string): Promise<RecipeSearchResult[]> {
    if (!query || query.trim() === "") {
        return [];
    }

    const searchUrl = `https://www.toprecepty.cz/vyhledavani-receptu?term=${encodeURIComponent(query)}`;

    let response: Response;
    try {
        response = await fetch(searchUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html",
            },
        });
    } catch {
        throw new SearchFetchError("Nepodařilo se připojit k TopRecepty.cz");
    }

    if (!response.ok) {
        throw new SearchFetchError(`Chyba při stahování: HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: RecipeSearchResult[] = [];

    // Set pro hlídání duplicit (aby se jeden recept neuložil dvakrát)
    const seenUrls = new Set<string>();

    // Zaměříme se jen na hlavní část stránky (vyhneme se hlavičkám a sidebaru)
    const $mainArea = $("main").length > 0 ? $("main") : $("body");

    $mainArea.find("article, [class*='recipe-card'], [class*='recipe-item']").each((_, el) => {
        const $el = $(el);

        // OCHRANA: Ignorovat posuvníky (carousels/sliders) a postranní panely,
        // kde bývají "Doporučené" recepty mimo vyhledávání.
        if ($el.closest(".swiper, .swiper-wrapper, .carousel, [class*='slider'], aside").length > 0) {
            return;
        }

        const $link = $el.find('a[href*="/recept/"]').first();
        const relativeUrl = $link.attr("href");
        if (!relativeUrl) return;

        const absoluteUrl = makeAbsoluteUrl(relativeUrl);

        // OCHRANA: Pokud jsme tento recept už přidali, přeskočíme ho
        if (seenUrls.has(absoluteUrl)) {
            return;
        }

        let title = normalizeWhitespace($el.find("h2, h3").first().text());
        if (!title) {
            title = normalizeWhitespace($link.attr("title") || $link.text());
        }

        const $img = $el.find("img").first();
        let imageUrl = $img.attr("data-src") || $img.attr("src") || "";

        if (!imageUrl && $img.attr("srcset")) {
            const srcset = $img.attr("srcset") || "";
            imageUrl = srcset.split(",")[0].trim().split(" ")[0];
        }

        // Vylepšené hledání popisku: vezmeme první odstavec nebo span, který má reálný text
        let description = 0;
        $el.find("p, [class*='perex'], [class*='desc'], span").each((_, descEl) => {
            const text = normalizeWhitespace($(descEl).text());
            // Popisek by měl být trochu delší než jen jedno slovo a neměl by to být samotný titulek
            if (text.length > 15 && text !== title && !description) {
                description = Number(text.replace("Recept ještě nebyl hodnocen", "").replace(",", ".").trim()) || 0;
            }
        });

        if (title && absoluteUrl) {
            seenUrls.add(absoluteUrl);
            results.push({
                title,
                url: absoluteUrl,
                imageUrl: imageUrl ? makeAbsoluteUrl(imageUrl) : "",
                score: description,
            });
        }
    });

    return results;
}