//! Intermediate tree shaking that uses global information but not good as the full tree shaking.

use anyhow::Result;
use turbo_rcstr::RcStr;
use turbo_tasks::{ResolvedVc, Vc};
use turbopack_core::module::Module;

use crate::{chunk::EcmascriptChunkPlaceable, references::esm::EsmAssetReference};

#[turbo_tasks::function]
pub async fn is_export_used(
    module: ResolvedVc<Box<dyn EcmascriptChunkPlaceable>>,
    export_name: RcStr,
) -> Result<Vc<bool>> {
    let references = module.references();

    for &reference in references.await?.iter() {
        let Some(reference) = ResolvedVc::try_downcast_type::<EsmAssetReference>(reference) else {
            continue;
        };
    }

    Ok(Vc::cell(true))
}
