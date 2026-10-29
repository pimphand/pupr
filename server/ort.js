import * as ort from 'onnxruntime-node';

export function createTensor(type, data, dims) {
  // onnxruntime-node Tensor constructor: new ort.Tensor(type, data, dims)
  // dims must be a plain array of numbers.
  return new ort.Tensor(type, data, dims);
}

export function createInt64Tensor(data, dims) {
  return new ort.Tensor('int64', data, dims);
}

export function createFloat32Tensor(data, dims) {
  return new ort.Tensor('float32', data, dims);
}
