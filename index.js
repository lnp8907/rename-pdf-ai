const fs = require("fs-extra");
const pdf2img = require("pdf-poppler");
const path = require("path");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");
const { exec } = require("child_process");
const OpenAI = require("openai");
const OPENAI_API_KEY = "";
const inputDir = "./input";
const outputDir = "./output";

// 初始化 OpenAI API
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 獲取資料夾中的 PDF 文件
const getPdfFiles = async (dir) => {
  try {
    const files = await fs.readdir(dir);
    return files.filter((file) => path.extname(file).toLowerCase() === ".pdf");
  } catch (error) {
    console.error("讀取 PDF 文件時出錯:", error);
    return [];
  }
};

// 處理單個 PDF 文件
const processPdf = async (filePath) => {
  try {
    const outputImagePath = path.join(__dirname, "output", "images");
    const opts = {
      format: "jpeg",
      out_dir: path.join(__dirname, "output", "temp", "images"),
      out_prefix: path.basename(filePath, path.extname(filePath)),
      page: 1,
    };

    // 將 PDF 轉換為圖像
    await pdf2img.convert(filePath, opts);
    console.log("PDF 轉換為圖像成功！");

    // 讀取圖像路徑
    const imagesPaths = fs
      .readdirSync(opts.out_dir)
      .filter((filename) => filename.startsWith(opts.out_prefix))
      .map((filename) => path.join(opts.out_dir, filename));

    // 垂直合並圖像
    await mergeImagesVertically(imagesPaths, outputImagePath, filePath);
  } catch (error) {
    console.error("處理 PDF 時出錯:", error);
  }
};

// 垂直合並圖像
const mergeImagesVertically = async (
  imagesPaths,
  outputImagePath,
  filePath
) => {
  try {
    let yOffset = 0;
    let compositeOptions = [];
    let maxWidth = 0;
    let totalHeight = 0;

    // 加載和準備圖像
    for (const imagePath of imagesPaths) {
      const image = sharp(imagePath);
      const metadata = await image.metadata();
      totalHeight += metadata.height;
      maxWidth = Math.max(maxWidth, metadata.width);
      compositeOptions.push({
        input: imagePath,
        top: yOffset,
        left: 0,
      });
      yOffset += metadata.height;
    }

    // 創建空白畫布
    const mergedImage = sharp({
      create: {
        width: maxWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    });

    // 將所有圖像添加到合成隊列
    const outputFilePath = path.join(
      outputImagePath,
      `${path.basename(filePath, path.extname(filePath))}.jpg`
    );
    await mergedImage.composite(compositeOptions).toFile(outputFilePath);

    // 在合並後的圖像上執行 OCR
    await performOCR(outputFilePath, filePath);
  } catch (error) {
    console.error("垂直合並圖像時出錯:", error);
  }
};

// 在合並後的圖像上執行 OCR
const performOCR = async (imagePath, pdfPath) => {
  try {
    const {
      data: { text },
    } = await Tesseract.recognize(imagePath, "eng+jpn");
    const result = await queryOpenAI(text);
    saveResult(result, pdfPath);
  } catch (error) {
    console.error("執行 OCR 時出錯:", error);
  }
};

// 向 OpenAI 查詢文章信息
const queryOpenAI = async (text) => {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You will be provided with a part of an article, Please provide the title, author, year, journal, volume, issue, and starting page of the article. If unknown, leave it as an empty string and respond in the language of the article. Return in JSON format. Additional Information: If you see numbers in a format like this at the end of the content, such as "71 4 688", typically 71 represents the volume, 4 represents the issue, and 688 represents the page number.`,
        },
        {
          role: "user",
          content: `${text}`,
        },
      ],
    });
    console.log(text);
    const newName = combineFields(
      JSON.parse(response.choices[0].message.content)
    );
    return {
      data: response.choices[0].message.content,
      newFilename: newName.replaceAll(" ", ""),
    };
  } catch (error) {
    console.error("向 OpenAI 查詢時出錯:", error);
    return "unknown";
  }
};

const combineFields = (data) => {
  const { author, title, year, journal, volume, issue, starting_page } = data;
  const fields = [author, year, title, journal, volume, issue, starting_page];
  return fields.filter((field) => field !== "").join(",");
};

// 將結果保存到輸出資料夾
const saveResult = (result, pdfFilePath) => {
  try {
    const outputFile = path.join(
      outputDir,
      "openai_result_log",
      `${result.newFilename + ".pdf"}-result.txt`
    );
    fs.writeFileSync(outputFile, result.data);
    // console.log("結果已保存:", outputFile);
    moveAndRenamePDF(pdfFilePath, result.newFilename);
  } catch (error) {
    console.error("保存結果時出錯:", error);
  }
};

// 移動並重命名 PDF 文件
const moveAndRenamePDF = (pdfPath, newName) => {
  const newFilePath = path.join(outputDir, "pdf", `${newName}.pdf`);
  fs.renameSync(pdfPath, newFilePath);
  console.log(`移動並重命名 PDF 文件: ${newName}`);
};

// 主函數
const main = async () => {
  try {
    const pdfFiles = await getPdfFiles(inputDir);
    if (pdfFiles.length === 0) {
      console.log("輸入資料夾中未找到 PDF 文件。");
      return;
    }

    // 使用 Promise.all 並行處理所有 PDF 文件
    await Promise.all(
      pdfFiles.map((file) => processPdf(path.join(inputDir, file)))
    );

    // 指定的文件夾路徑
    const folderPath = path.join(outputDir, "pdf"); // 替換為您的文件夾路徑
    // 打開指定文件夾
    openFolder(folderPath);
    console.log("所有文件處理成功。");
  } catch (error) {
    console.error("處理文件時出錯:", error);
  }
};

// 打開指定文件夾
const openFolder = (folderPath) => {
  // 在 Windows 上使用 Explorer
  if (process.platform === "win32") {
    exec(`explorer "${folderPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error opening folder: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
        return;
      }
    });
  }
  // 在 macOS 上使用 Finder
  else if (process.platform === "darwin") {
    exec(`open "${folderPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error opening folder: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
        return;
      }
    });
  }
  // 在 Linux 上使用文件管理器（根據您的系統和配置可能有所不同）
  else {
    exec(`xdg-open "${folderPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error opening folder: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
        return;
      }
    });
  }
};

// 執行主函數
main();
