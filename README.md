


## 单向源码兼容复核
proto2ts 目录 npm run build 后：node dist/src/compat-cli.js writer.proto reader.proto WriterRoot ReaderRoot [report.json]。复核“所有合法写端消息都能被新读端读出相同已知值”：字段按编号匹配，名称及类型声明顺序不参与身份；双方精确标量类型和 repeated 属性必须一致，packed 与非 packed 的 repeated 数值可互读。读端新增 required 或把可省略字段变 required 不兼容；写端移除在读端非 required 的字段可保留为未知，不使复核失败。递归 message 按字段所引用结构比较，只复核根可达部分，允许重命名和环。报告给出有限、稳定的最短字段编号路径及具体不兼容种类。非法源码或根整次失败并保留原报告。
