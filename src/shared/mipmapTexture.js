import { Material, Sampler, TextureMinificationFilter, TextureWrap } from "cesium";

/**
 * Cesium's Material uploads image uniforms without mipmaps, so a detailed pattern tile that
 * is drawn much smaller than its native size aliases badly (moiré bands). This hooks the
 * material's update so that, once the image texture has loaded, mipmaps are generated and a
 * trilinear sampler with the requested wrap modes is applied.
 *
 * Relies on the private `Material._textures` map and `_loadedImages` queue; revisit if Cesium
 * changes them.
 *
 * It also keeps `material.loadingImages`, the set of image uniforms whose image is set but not
 * on the GPU yet (including a swap from one image to another, during which the old texture is
 * still bound). Material only turns a loaded image into a texture on a later update, so with
 * the scene's requestRenderMode on, the caller must keep requesting frames while this set is
 * not empty, or the image never appears until the camera moves.
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
  material.loadingImages ??= new Set();

  material.update = function (context) {
    originalUpdate(context);
    const texture = material._textures[uniformName];
    const value = material.uniforms[uniformName];
    const hasImage = value !== undefined && value !== null && value !== Material.DefaultImageId;
    // A new image waits in the private `_loadedImages` queue for the next update; meanwhile the
    // old texture (or the placeholder) is still bound.
    const queued = material._loadedImages.some((loaded) => loaded.id === uniformName);
    if (queued || (hasImage && (!texture || texture === context.defaultTexture))) {
      material.loadingImages.add(uniformName);
    } else {
      material.loadingImages.delete(uniformName);
    }
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
