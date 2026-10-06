/**
 * AssetStudio's own `SpriteHelper.CutImage` over the 2019.4 and 6000.3 fixture
 * sprites, where the sprite golden carries an oracle note: the tight-mesh
 * images, and Rotate90. Cross-check values under plan §6, not goldens; how
 * they were made: `fixtures/README.md`, Oracle notes, "AssetStudio sprite
 * cross-check hashes". Both editors give the same images, so they are keyed by
 * sprite name. Rows as stored, bottom row first, like the goldens. Shared by
 * `sprite.test.ts` and `sprite-6000-6.test.ts` (#229), which checks the same
 * sprites packed into a 6000.6 atlas against them.
 */
export const ASSETSTUDIO_RGBA: Record<string, string> = {
  p_diamond: "0a7b380ab7f95d6feb561f0468f0b2bb282c78e3d9c63e5619be8ddc00cde9cf",
  p_ell: "166f5bc558ab7f004b86119f9cab535068c8139735200bbac43ac32d425137dc",
  p_ell2: "3a9600dacc52f1b61b6de414629a88710a8e0ee062ad2c688e25b3afde14909f",
  p_ell3: "e37a22104bb7e50d97548e0d18a577fa6ae3df31691084ac1e552a0e17b84b77",
  p_margin: "3936b7818be9fd72ae809097cfb9270a902ecf3b1215400c456337785f8d4bf3",
  p_tri: "2ba2b3c1fff25af21e6da9f533db46bf1dd7c1d5db2871e7ef895fa94b46cb49",
  p_tri2: "ffb44a725428f841b9c87bb5497e0aaae9ce798b781decdb1da6e889b4beac22",
  p_tri3: "287510cc84e8a14560e209e0948abb02ada4f2e7d61215db8ffbec2a68037de8",
  p_tri4: "83bf159f814c2410b73d5ecb4dd32a95e4308d27b1e434eb5787bc35b40eb13f",
  p_tri5: "2d3091d6a369c3edc5889de42f9dd32651bba5b3a4635aa345d2d0fc4b40e18d",
  p_tri6: "a5060e4760d61cf201f949555026fc77bfb6edd87a0fde49dad7a84055c36c1f",
  sheet_d: "508c8a19096e38475961bc8e59c4b28ab218ff98237e7c3b87aed48a01d5817b",
  tight: "82efdcbd6983dc346f0da8cdf1557bd7f25a81467d94e5b1b774a3fc4d25e29e",
  "sheet_b Rotate90": "b5938b891b614c0eb204d0245eb298bb1548f324b8fbffd350ab80326c168101",
  // Hand-made triangles, in sprite.test.ts.
  "synthetic quad": "30ed0874322235af4cf18b9bf379df2cc8431a3c2b7dc8598cc4bca7e6496349",
  "synthetic tri": "f201210184ab19746b302dbbd73aa9a0c95ca0f00c14c19dc6e2bafbaee3c106",
  "synthetic thin": "dc9543488b54769bb17db2dbe5728acb068671d83529f81fd44ce2a6afc7d83d",
};

/**
 * The image each fixture sprite was cut from, by name (`BuildSprites.cs` in
 * `fixtures/BUILDING.md` section 12): pixel (x, y), y from the bottom, of
 * image `id` is R = 5x + 3, G = 5y + 5, B = 16 id + 7, all mod 256. The sheet
 * sprites are cut from one image, the rest are each their own.
 */
export const IMAGE_ID: Record<string, number> = {
  sheet_a: 1, sheet_b: 1, sheet_c: 1, sheet_d: 1, tight: 2, p_tall: 3, p_wide: 4, p_tri: 5,
  p_tri2: 6, p_tri3: 7, p_ell: 8, p_diamond: 9, p_tri4: 10, p_tri5: 11, p_ell2: 12, p_ell3: 13,
  p_bar: 14, p_bar2: 15, p_tri6: 1, p_margin: 2, r_a: 11, r_b: 12,
};
