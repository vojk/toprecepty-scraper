import * as cheerio from "cheerio";

// ==========================================
// 1. TYPY A ROZHRANÍ
// ==========================================

export interface ParsedIngredient {
    amount: number | null;
    unit: string | null;
    name: string;
    raw: string; // Původní vyčištěný text
}

export interface RecipeStep {
    stepNumber: number;
    text: string;
}

export interface IngredientGroup<TIngredient> {
    category: string | null;
    items: TIngredient[];
}

export interface ScrapedRecipe<TIngredient = ParsedIngredient> {
    title: string;
    sourceUrl: string;
    imageUrl: string;
    description: string;
    ingredients: IngredientGroup<TIngredient>[];
    instructions: RecipeStep[];
}

export interface ScraperOptions<TIngredient> {
    // Možnost přepsat výchozí parser ingrediencí
    parseIngredient?: (rawLine: string) => TIngredient;
}

// ==========================================
// 2. CHYBOVÉ TŘÍDY
// ==========================================

export class ScrapeValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScrapeValidationError";
    }
}

export class ScrapeFetchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScrapeFetchError";
    }
}

export class ScrapeParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScrapeParseError";
    }
}

// ==========================================
// 3. PARSOVÁNÍ A ČIŠTĚNÍ INGREDIENCÍ
// ==========================================

/**
 * Odstraní nesmyslné duplicity vzniklé scrapováním (např. "1 1 vejce 1" -> "1 vejce")
 */
function cleanDuplicatedText(raw: string): string {
    const words = raw.split(" ").filter(Boolean);
    const uniqueWords: string[] = [];

    for (const word of words) {
        if (!uniqueWords.includes(word)) {
            uniqueWords.push(word);
        }
    }

    return uniqueWords.join(" ");
}

/**
 * Výchozí parser, který z textu vytáhne množství, jednotku a název
 */
export function defaultIngredientParser(messyRawLine: string): ParsedIngredient {
    const cleanLine = cleanDuplicatedText(messyRawLine);

    const parsed: ParsedIngredient = {
        amount: null,
        unit: null,
        name: cleanLine,
        raw: cleanLine,
    };

    // Zkusíme najít číslo na začátku (zvládá i desetinné čárky)
    const amountMatch = cleanLine.match(/^([\d.,]+)\s*/);
    if (amountMatch) {
        parsed.amount = parseFloat(amountMatch[1].replace(",", "."));
        parsed.name = cleanLine.substring(amountMatch[0].length).trim();
    }

    // Zkusíme najít známou jednotku hned za číslem
    const knownUnits = ["g", "kg", "ml", "l", "ks", "lžíce", "lžic", "lžička", "lžičky", "špetka", "sáček", "hrnek", "stroužek", "stroužky"];

    for (const unit of knownUnits) {
        const regex = new RegExp(`^${unit}\\b`, "i");
        if (regex.test(parsed.name)) {
            parsed.unit = unit;
            parsed.name = parsed.name.replace(regex, "").trim();
            break;
        }
    }

    // Odstranění přebytečných znaků na začátku (pokud tam zbylo třeba "z" nebo pomlčka)
    parsed.name = parsed.name.replace(/^[-\s]+/, "");

    return parsed;
}

// ==========================================
// 4. POMOCNÉ FUNKCE PRO HTML/DOM
// ==========================================

function assertTopreceptyUrl(url: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new ScrapeValidationError("Invalid URL");
    }
    const host = parsed.hostname.replace(/^www\./, "");
    if (host !== "toprecepty.cz") {
        throw new ScrapeValidationError("URL must be from toprecepty.cz");
    }
    return parsed;
}

function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

type JsonLdNode = Record<string, unknown>;

function findRecipeInJsonLd($: cheerio.CheerioAPI): JsonLdNode | null {
    const recipes: JsonLdNode[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const content = $(el).html();
        if (!content) return;
        try {
            const parsed = JSON.parse(content);
            const walk = (data: unknown) => {
                if (Array.isArray(data)) {
                    data.forEach(walk);
                } else if (data && typeof data === "object") {
                    const obj = data as JsonLdNode;
                    if (obj["@type"] === "Recipe") {
                        recipes.push(obj);
                    } else {
                        Object.values(obj).forEach(walk);
                    }
                }
            };
            walk(parsed);
        } catch {
            // ignore JSON errors
        }
    });
    return recipes[0] ?? null;
}

function extractCategorizedIngredients<T>(
    $: cheerio.CheerioAPI,
    parser: (raw: string) => T
): IngredientGroup<T>[] {
    const groups: IngredientGroup<T>[] = [];
    let currentGroup: IngredientGroup<T> = { category: null, items: [] };
    groups.push(currentGroup);

    const $container = $(".b-ingredients, .b-recipe-ingredients").first();

    if ($container.length > 0) {
        $container.find(".b-ingredients__item, h3, h4, .b-ingredients__subtitle").each((_, el) => {
            const $el = $(el);

            if ($el.hasClass("b-ingredients__item")) {
                // Načteme celý text řádku
                const text = normalizeWhitespace($el.text());
                if (text) {
                    currentGroup.items.push(parser(text));
                }
            } else {
                const categoryName = normalizeWhitespace($el.text());
                if (categoryName) {
                    if (currentGroup.items.length === 0 && currentGroup.category === null) {
                        currentGroup.category = categoryName;
                    } else {
                        currentGroup = { category: categoryName, items: [] };
                        groups.push(currentGroup);
                    }
                }
            }
        });
    }

    return groups.filter((g) => g.items.length > 0);
}

function extractStructuredInstructions($: cheerio.CheerioAPI): RecipeStep[] {
    const steps: RecipeStep[] = [];

    $(".b-recipe__steps li, .b-recipe-steps__item").each((_, el) => {
        const text = normalizeWhitespace($(el).text());
        if (text) {
            steps.push({ stepNumber: steps.length + 1, text });
        }
    });

    if (steps.length === 0) {
        const fallbackText = normalizeWhitespace($(".b-recipe__description").text());
        if (fallbackText) {
            fallbackText.split(/\n+/).forEach((paragraph) => {
                const pText = paragraph.trim();
                if (pText) {
                    steps.push({ stepNumber: steps.length + 1, text: pText });
                }
            });
        }
    }

    return steps;
}

// ==========================================
// 5. HLAVNÍ SCRAPOVACÍ FUNKCE
// ==========================================

export async function scrapeToprecepty<TIngredient = ParsedIngredient>(
    url: string,
    options?: ScraperOptions<TIngredient>
): Promise<ScrapedRecipe<TIngredient>> {
    const parsedUrl = assertTopreceptyUrl(url);

    // Zde používáme nový výchozí parser, pokud není předán jiný
    const ingredientParser = options?.parseIngredient ?? (defaultIngredientParser as unknown as (raw: string) => TIngredient);

    let response: Response;
    try {
        response = await fetch(parsedUrl.toString(), {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                Accept: "text/html",
            },
        });
    } catch {
        throw new ScrapeFetchError("Nepodařilo se připojit k webu");
    }

    if (!response.ok) {
        throw new ScrapeFetchError(`Chyba při stahování: HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const recipeNode = findRecipeInJsonLd($);
    let title = $("h1").first().text().trim();
    let description = "";
    let imageUrl = "";

    // 1. Získání metadat z JSON-LD
    if (recipeNode) {
        if (typeof recipeNode.name === "string") title = recipeNode.name.trim();
        if (typeof recipeNode.description === "string") description = recipeNode.description.trim();

        if (recipeNode.image) {
            if (typeof recipeNode.image === "string") {
                imageUrl = recipeNode.image;
            } else if (Array.isArray(recipeNode.image) && recipeNode.image.length > 0) {
                imageUrl = typeof recipeNode.image[0] === "string" ? recipeNode.image[0] : (recipeNode.image[0] as any)?.url || "";
            } else if (typeof recipeNode.image === "object") {
                imageUrl = (recipeNode.image as any)?.url || "";
            }
        }
    }

    if (!title) {
        throw new ScrapeParseError("Nepodařilo se najít titulek receptu");
    }

    // Záloha pro obrázek (Open Graph)
    if (!imageUrl) {
        imageUrl = $('meta[property="og:image"]').attr("content") || "";
    }

    // 2. Ingredience z HTML s podporou kategorií
    let ingredients = extractCategorizedIngredients($, ingredientParser);

    // Záloha ingrediencí z JSON-LD, pokud HTML selže
    if (ingredients.length === 0 && recipeNode && Array.isArray(recipeNode.recipeIngredient)) {
        const jsonLdIngredients = recipeNode.recipeIngredient
            .filter((line): line is string => typeof line === "string")
            .map((line) => ingredientParser(line));

        if (jsonLdIngredients.length > 0) {
            ingredients = [{ category: null, items: jsonLdIngredients }];
        }
    }

    if (ingredients.length === 0) {
        throw new ScrapeParseError("Nepodařilo se vyextrahovat ingredience");
    }

    // 3. Kroky postupu
    let instructions = extractStructuredInstructions($);

    // Záloha instrukcí z JSON-LD
    if (instructions.length === 0 && recipeNode && recipeNode.recipeInstructions) {
        const rawInstr = recipeNode.recipeInstructions;
        if (Array.isArray(rawInstr)) {
            instructions = rawInstr.map((step, i) => {
                const text = typeof step === "string" ? step.trim() : typeof step === "object" && typeof (step as any).text === "string" ? (step as any).text.trim() : "";
                return { stepNumber: i + 1, text };
            }).filter(s => s.text);
        } else if (typeof rawInstr === "string") {
            instructions = rawInstr.split(/\n+/).map((txt, i) => ({ stepNumber: i + 1, text: txt.trim() })).filter(s => s.text);
        }
    }

    return {
        title,
        sourceUrl: parsedUrl.toString(),
        imageUrl,
        description,
        ingredients,
        instructions,
    };
}