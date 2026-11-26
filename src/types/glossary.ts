/** Campaign-local reading aids. These are not lore retrieval triggers. */
export type GlossaryEntry = {
    id: string;
    name: string;
    aliases: string;
    description: string;
    category?: string;
    image?: string;
};
