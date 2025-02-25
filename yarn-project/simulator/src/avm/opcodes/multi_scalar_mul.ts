import { Fq, Point } from '@aztec/circuits.js';
import { Grumpkin } from '@aztec/foundation/crypto';

import { type AvmContext } from '../avm_context.js';
import { Field, TypeTag, Uint1 } from '../avm_memory_types.js';
import { MSMPointNotOnCurveError, MSMPointsLengthError } from '../errors.js';
import { Opcode, OperandType } from '../serialization/instruction_serialization.js';
import { Addressing } from './addressing_mode.js';
import { Instruction } from './instruction.js';

export class MultiScalarMul extends Instruction {
  static type: string = 'MultiScalarMul';
  static readonly opcode: Opcode = Opcode.MSM;

  // Informs (de)serialization. See Instruction.deserialize.
  static readonly wireFormat: OperandType[] = [
    OperandType.UINT8 /* opcode */,
    OperandType.UINT8 /* indirect */,
    OperandType.UINT16 /* points vector offset */,
    OperandType.UINT16 /* scalars vector offset */,
    OperandType.UINT16 /* output offset (fixed triplet) */,
    OperandType.UINT16 /* points length offset */,
  ];

  constructor(
    private indirect: number,
    private pointsOffset: number,
    private scalarsOffset: number,
    private outputOffset: number,
    private pointsLengthOffset: number,
  ) {
    super();
  }

  public async execute(context: AvmContext): Promise<void> {
    const memory = context.machineState.memory;
    // Resolve indirects
    const operands = [this.pointsOffset, this.scalarsOffset, this.outputOffset, this.pointsLengthOffset];
    const addressing = Addressing.fromWire(this.indirect, operands.length);
    const [pointsOffset, scalarsOffset, outputOffset, pointsLengthOffset] = addressing.resolve(operands, memory);

    // Length of the points vector should be U32
    memory.checkTag(TypeTag.UINT32, pointsLengthOffset);
    // Get the size of the unrolled (x, y , inf) points vector
    const pointsReadLength = memory.get(pointsLengthOffset).toNumber();
    if (pointsReadLength % 3 !== 0) {
      throw new MSMPointsLengthError(pointsReadLength);
    }

    // Get the unrolled (x, y, inf) representing the points
    // Important to perform this before tag validation, as getSlice() first checks
    // that the slice is not out of memory range. This needs to be aligned with circuit.
    const pointsVector = memory.getSlice(pointsOffset, pointsReadLength);

    // Divide by 3 since each point is represented as a triplet to get the number of points
    const numPoints = pointsReadLength / 3;
    // The tag for each triplet will be (Field, Field, Uint8)
    for (let i = 0; i < numPoints; i++) {
      const offset = pointsOffset + i * 3;
      // Check (Field, Field)
      memory.checkTagsRange(TypeTag.FIELD, offset, 2);
      // Check Uint1 (inf flag)
      memory.checkTag(TypeTag.UINT1, offset + 2);
    }

    // The size of the scalars vector is twice the NUMBER of points because of the scalar limb decomposition
    const scalarReadLength = numPoints * 2;
    context.machineState.consumeGas(this.gasCost(pointsReadLength));
    // Get the unrolled scalar (lo & hi) representing the scalars
    const scalarsVector = memory.getSlice(scalarsOffset, scalarReadLength);
    memory.checkTagsRange(TypeTag.FIELD, scalarsOffset, scalarReadLength);

    // Now we need to reconstruct the points and scalars into something we can operate on.
    const grumpkinPoints: Point[] = [];
    for (let i = 0; i < numPoints; i++) {
      const isInf = pointsVector[3 * i + 2].toNumber() === 1;
      const p: Point = new Point(pointsVector[3 * i].toFr(), pointsVector[3 * i + 1].toFr(), isInf);
      if (!p.isOnGrumpkin()) {
        throw new MSMPointNotOnCurveError(p);
      }
      grumpkinPoints.push(p);
    }
    // The scalars are read from memory as Fr elements, which are limbs of Fq elements
    // So we need to reconstruct them before performing the scalar multiplications
    const scalarFqVector: Fq[] = [];
    for (let i = 0; i < numPoints; i++) {
      const scalarLo = scalarsVector[2 * i].toFr();
      const scalarHi = scalarsVector[2 * i + 1].toFr();
      const fqScalar = Fq.fromHighLow(scalarHi, scalarLo);
      scalarFqVector.push(fqScalar);
    }
    // TODO: Is there an efficient MSM implementation in ts that we can replace this by?
    const grumpkin = new Grumpkin();
    // Zip the points and scalars into pairs
    const [firstBaseScalarPair, ...rest]: Array<[Point, Fq]> = grumpkinPoints.map((p, idx) => [p, scalarFqVector[idx]]);
    // Fold the points and scalars into a single point
    // We have to ensure get the first point, since the identity element (point at infinity) isn't quite working in ts
    let acc = await grumpkin.mul(firstBaseScalarPair[0], firstBaseScalarPair[1]);
    for (const curr of rest) {
      if (curr[1] === Fq.ZERO) {
        // If we multiply by 0, the result will the point at infinity - so we ignore it
        continue;
      } else if (curr[0].inf) {
        // If we multiply the point at infinity by a scalar, it's still the point at infinity
        continue;
      } else if (acc.inf) {
        // If we accumulator is the point at infinity, we can just return the current point
        acc = curr[0];
      } else {
        acc = await grumpkin.add(acc, await grumpkin.mul(curr[0], curr[1]));
      }
    }
    const outputPoint = acc;

    // Important to use setSlice() and not set() in the two following statements as
    // this checks that the offsets lie within memory range.
    memory.setSlice(outputOffset, [new Field(outputPoint.x), new Field(outputPoint.y)]);
    // Check representation of infinity for grumpkin
    memory.setSlice(outputOffset + 2, [new Uint1(outputPoint.equals(Point.ZERO) ? 1 : 0)]);
  }
}
