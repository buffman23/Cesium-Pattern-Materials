import { Sampler, TextureMinificationFilter, TextureWrap } from "cesium";

/**
 * Cesium's Material uploads image uniforms without mipmaps, so a detailed pattern tile that
 * is drawn much smaller than its native size aliases badly (moiré bands). This hooks the
 * material's update so that, once the image texture has loaded, mipmaps are generated and a
 * trilinear sampler with the requested wrap modes is applied.
 *
 * Relies on the private `Material._textures` map; revisit if Cesium changes it.
 *
 * @param {Material} material
 * @param {string} uniformName Name of the sampler2D uniform holding the image.
 * @param {object} [options]
 * @param {TextureWrap} [options.wrapS=TextureWrap.REPEAT]
 * @param {TextureWrap} [options.wrapT=TextureWrap.REPEAT]
 */
export default function mipmapTexture(
  material,
  uniformName,
  { wrapS = TextureWrap.REPEAT, wrapT = TextureWrap.REPEAT } = {},
) {
  const originalUpdate = material.update.bind(material);
  let mipmapped;

  material.update = function (context) {
    originalUpdate(context);
    const texture = material._textures[uniformName];
    if (!texture || texture === context.defaultTexture || texture === mipmapped) {
      return;
    }
    texture.generateMipmap();
    texture.sampler = new Sampler({
      wrapS,
      wrapT,
      minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
      maximumAnisotropy: 8,
    });
    mipmapped = texture;
  };
  return material;
}
