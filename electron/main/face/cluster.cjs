'use strict';

/**
 * 人脸特征向量的聚类（纯逻辑，无 ONNX / 无文件 IO）。
 *
 * 采用最朴素的「增量最近质心」策略：
 *   - 新脸与现存人物质心的余弦相似度 ≥ 阈值 → 归入该人物；
 *   - 否则新建一个人物。
 *
 * 不做层次聚类 / DBSCAN 是刻意的：相册场景里人物数量少、脸特征已经过 L2 归一化，
 * 单一阈值够用；误合并可以靠界面上的「合并」纠正，漏合并也能手动合并，
 * 而复杂聚类在 Node 里既慢又难解释。
 */

/** 同一人脸的余弦相似度阈值（buffalo_sc 的经验值，偏保守以减少误合并） */
const SIMILARITY_THRESHOLD = 0.36;

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function normalize(vector) {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return new Float32Array(vector.length);
  const result = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) result[i] = vector[i] / norm;
  return result;
}

/**
 * 计算一组已归一化向量的质心（均值再归一化）。
 * @param {Float32Array[]} embeddings
 * @returns {Float32Array}
 */
function centroidOf(embeddings) {
  if (embeddings.length === 0) return new Float32Array(0);
  const sum = new Float32Array(embeddings[0].length);
  for (const embedding of embeddings) {
    for (let i = 0; i < sum.length; i += 1) sum[i] += embedding[i];
  }
  return normalize(sum);
}

/**
 * 在既有质心里找最相似的一个。
 * @param {Float32Array[]} centroids
 * @param {Float32Array} embedding
 * @param {number} threshold
 * @returns {{index:number, similarity:number}} index=-1 表示没有匹配
 */
function findClosest(centroids, embedding, threshold = SIMILARITY_THRESHOLD) {
  let bestIndex = -1;
  let bestSimilarity = -1;
  for (let i = 0; i < centroids.length; i += 1) {
    if (!centroids[i] || centroids[i].length !== embedding.length) continue;
    const similarity = dot(centroids[i], embedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestIndex = i;
    }
  }
  if (bestSimilarity < threshold) return { index: -1, similarity: bestSimilarity };
  return { index: bestIndex, similarity: bestSimilarity };
}

module.exports = {
  SIMILARITY_THRESHOLD,
  dot,
  normalize,
  centroidOf,
  findClosest,
};
