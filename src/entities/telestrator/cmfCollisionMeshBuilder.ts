import * as THREE from 'three';

const CMF_SCALE_TO_UU = 50;

export function buildCmfCollisionMeshes(
  chunks: readonly Uint8Array[],
  doubleSide = false
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  const material = new THREE.MeshBasicMaterial({
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    visible: false,
  });

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (chunk.byteLength < 8) continue;

    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const numTris = view.getUint32(0, true);
    const numVerts = view.getUint32(4, true);
    const expectedBytes = 8 + numTris * 12 + numVerts * 12;
    if (numTris === 0 || numVerts === 0 || chunk.byteLength < expectedBytes) continue;

    const indices = new Uint32Array(numTris * 3);
    let idxOffset = 8;
    for (let t = 0; t < numTris; t++) {
      const i0 = view.getUint32(idxOffset, true);
      const i1 = view.getUint32(idxOffset + 4, true);
      const i2 = view.getUint32(idxOffset + 8, true);
      // Swap (i1, i2) to counteract Y/Z swap reflection so normals face inward
      indices[t * 3] = i0;
      indices[t * 3 + 1] = i2;
      indices[t * 3 + 2] = i1;
      idxOffset += 12;
    }

    const positions = new Float32Array(numVerts * 3);
    let vertOffset = 8 + numTris * 12;
    for (let v = 0; v < numVerts; v++) {
      const bx = view.getFloat32(vertOffset, true);
      const by = view.getFloat32(vertOffset + 4, true);
      const bz = view.getFloat32(vertOffset + 8, true);
      positions[v * 3] = bx * CMF_SCALE_TO_UU;
      positions[v * 3 + 1] = bz * CMF_SCALE_TO_UU;
      positions[v * 3 + 2] = by * CMF_SCALE_TO_UU;
      vertOffset += 12;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `CmfCollisionChunk_${c}`;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrixWorld(true);
    meshes.push(mesh);
  }

  return meshes;
}

export function disposeCmfCollisionMeshes(meshes: readonly THREE.Mesh[]): void {
  const materials = new Set<THREE.Material>();
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    m.geometry.dispose();
    if (Array.isArray(m.material)) {
      for (const mat of m.material) materials.add(mat);
    } else if (m.material) {
      materials.add(m.material);
    }
  }
  for (const mat of materials) mat.dispose();
}
