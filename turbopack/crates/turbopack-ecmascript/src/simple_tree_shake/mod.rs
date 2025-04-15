//! Intermediate tree shaking that uses global information but not good as the full tree shaking.

use anyhow::Result;
use turbo_rcstr::RcStr;
use turbo_tasks::{ResolvedVc, Vc};

use crate::chunk::EcmascriptChunkPlaceable;

#[turbo_tasks::function]
pub async fn is_export_used(
    module: ResolvedVc<Box<dyn EcmascriptChunkPlaceable>>,
    export_name: RcStr,
) -> Result<Vc<bool>> {
}
