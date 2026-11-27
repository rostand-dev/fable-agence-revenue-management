import { expect, test } from "@playwright/test";

/**
 * Logements et propriétaires créés par un test : supprimés après lui par l'API de l'application, y compris après un échec
 * et sur un environnement distant sans accès à la base (Preview), où ils s'accumulaient dans le compte de démo.
 * `useCreated()` s'appelle en tête de fichier ; `.property(id)` ou `.owner(id)` après chaque création
 * faite avec la session de `page`.
 */
export function useCreated() {
  const properties: string[] = [], owners: string[] = [];
  test.afterEach(async ({ page }) => {
    for (const id of properties.splice(0)) {
      const got = await page.request.get(`/api/v1/properties/${id}`);
      if (got.status() === 404) continue; // le test l'a déjà supprimé
      // le nom exact est exigé, et le test a pu le changer
      const res = await page.request.delete(`/api/v1/properties/${id}`, { data: { confirmName: (await got.json()).name } });
      expect.soft(res.status(), `suppression du logement de test ${id} : ${await res.text()}`).toBe(200);
    }
    // après les logements : un propriétaire qui en porte encore un ne se supprime pas
    for (const id of owners.splice(0)) await page.request.delete(`/api/v1/owners/${id}`);
  });
  return { property: (id: string) => { properties.push(id); return id; }, owner: (id: string) => { owners.push(id); return id; } };
}
