# RISC-V Pipeline Visualizer

Simulador educativo estático de un pipeline RISC-V clásico de 5 etapas: **IF → ID → EX → MEM → WB**.

## Funciones
- Editor de instrucciones RISC-V.
- Direcciones PC configurables (por defecto 40, 44, 48, ...).
- Banco de registros x0–x31 editable.
- Memoria de datos.
- Ejecución paso a paso o automática.
- Forwarding EX/MEM y MEM/WB.
- Stall por load-use.
- Branches `beq`/`bne` con flush por mala predicción.
- Predictor Always Not Taken o de 1 bit.
- Riesgo estructural opcional con memoria única de un puerto.
- Excepciones didácticas por instrucción ilegal y acceso desalineado.
- Tabla temporal por ciclos y panel de eventos.

## Subconjunto soportado
`add`, `sub`, `and`, `or`, `addi`, `lw`, `sw`, `beq`, `bne`, `nop`.

## Abrir localmente
Haz doble clic sobre `index.html`.

## Publicar en Vercel
1. Crea un repositorio en GitHub y sube estos archivos.
2. En Vercel: **Add New → Project**.
3. Importa el repositorio.
4. Framework Preset: **Other**.
5. No necesitas Build Command.
6. Pulsa **Deploy**.
